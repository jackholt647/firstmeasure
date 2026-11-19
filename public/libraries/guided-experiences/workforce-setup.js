// The workforce setup's own pages (guided experience `operations.workforce.setup`, GP-28,
// docs/architecture/guided-experiences.md "Who does the work"). Operations' Workforce card and the Operations tab's Labor
// Setup tag play it, after the setup steps it requires (what kind of company, what work it does, who does most of it),
// each asked only while unanswered. One step that keeps its own pages:
//   who     who does the work at the company: the company profile's `workforce` answer. It is the setup step
//           `company.workforce` the setup requires, asked once for every setup that needs it (GP-65), so this page is
//           only shown when it is still unanswered or someone goes back to change it, and it is that step's own part
//           (setup-steps/company-profile.js, part `workforce`), saved with company-profile.save when it changes.
//   count   how many crews and how many subcontractors, each from 0. The ones the organization already has are counted
//           and kept.
//   work    each one named, which services it does (one the company profile left out found under Other), the kinds of
//           each it does in the company's own words (metal roofs, flat roofs: the step's `service_tags` to start from,
//           library data), and (a crew) who is in it, someone new added on the spot, and who is in charge, optionally.
//   pay     how each is paid: piece rate, hourly or per job, defaulted by industry (the step's `pay_defaults`, library
//           data); "same as" another one; or their pay sheet handed to the agent.
//   invite  whether to invite the crews' people who have not joined yet to the app (skippable; only when someone can
//           be invited and the person may invite).
//   see     having said yes: what the crews' members see in the app (the step's `crew_apps`, library data), saved as
//           each crew's App experience settings. The last page before done writes everything.
//   done    what was set up, after operations.workforce.setup.apply wrote it; Done finishes the setup.
// The cards sit side by side, on a large sheet (ctx.setWide); more than three scroll as a carousel that shows part of
// the cards on either side. What a
// group or company is called comes from the terminology system ("crew" is not a platform word). Everything it shows is
// read through the publication layer (workforce-setup.status); the writes are published actions, run as the person with
// a key of their own each time: someone new is added with workforce.users.add when the setup is saved, and invited with
// workforce.users.invite after it.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
const fold = (value) => clean(value).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const GROUP = 'resource_group', COMPANY = 'organization_connection';
const MAX_EACH = 20;
const PENDING = 'new-person:';
const isPending = (id) => String(id || '').startsWith(PENDING);

const css = `
.gxw{display:flex;flex-direction:column;gap:16px;min-width:0;padding:2px 0 8px;color:#101828}
.gxw p{margin:0;color:#475467;line-height:1.5}
.gxw-icon{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025);font-size:17px}
.gxw-counts{display:flex;flex-direction:column;border:1px solid #eaecf0;border-radius:14px;background:#fff;overflow:hidden}
.gxw-count{display:flex;align-items:center;gap:12px;padding:14px 16px;border-top:1px solid #f2f4f7}
.gxw-count:first-child{border-top:0}
/* Only the words grow: the icon and the stepper keep their own width on every row. */
.gxw-count-text{flex:1 1 auto;min-width:0}
.gxw-count strong{display:block;font-size:14.5px}
.gxw-count small{display:block;font-size:12.5px;color:#667085;margin-top:2px}
.gxw-step{display:inline-flex;align-items:center;flex:none;width:auto;height:38px;border:1px solid #d0d5dd;border-radius:11px;background:#fff;overflow:hidden}
.gxw-step button{flex:none;width:36px;height:100%;border:0;background:transparent;font:inherit;font-size:17px;color:#475467;cursor:pointer}
.gxw-step button:hover:not(:disabled){background:#f2f4f7}
.gxw-step button:disabled{opacity:.35;cursor:default}
.gxw-step input{flex:none;width:44px;height:100%;border:0;border-left:1px solid #eaecf0;border-right:1px solid #eaecf0;text-align:center;font:inherit;font-size:15px;font-weight:650;color:#101828;outline:none;-moz-appearance:textfield;appearance:textfield}
.gxw-step input::-webkit-outer-spin-button,.gxw-step input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.gxw-step:focus-within{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
/* The cards: side by side, as many as fit (three at most). More scroll sideways as a carousel that keeps three in the
   middle and part of the one before and after in view (3.5 card widths), so nobody misses the ones off to the side. */
.gxw-deck{position:relative;min-width:0}
.gxw-track{display:grid;grid-auto-flow:column;grid-auto-columns:min(480px,calc((100% - 4px - (var(--n,1) - 1) * 16px) / var(--n,1)));align-items:start;gap:16px;overflow-x:auto;overflow-y:visible;scroll-snap-type:x mandatory;padding:2px 2px 12px;scrollbar-width:thin;overscroll-behavior-x:contain}
.gxw-track[data-more]{grid-auto-columns:calc((100% - 4px - 64px) / 3.5)}
/* A card: its name as the title with what it is (crew, subcontractor) at the top right, then roomy sections. */
.gxw-card{position:relative;scroll-snap-align:center;display:flex;flex-direction:column;gap:20px;min-width:0;padding:20px;border:1px solid #e4e7ec;border-radius:18px;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.06)}
.gxw-card>header{display:flex;align-items:flex-start;gap:12px;min-width:0}
.gxw-card>header>strong,.gxw-title{flex:1 1 auto;min-width:0}
.gxw-card>header>strong{font-size:18px;font-weight:700;line-height:1.3;padding-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxw-name{display:block;width:100%;box-sizing:border-box;height:40px;margin:-4px 0 0 -10px;width:calc(100% + 10px);border:1px solid transparent;border-radius:10px;background:transparent;padding:0 10px;font:inherit;font-size:18px;font-weight:700;color:#101828;outline:none;transition:border-color .15s,background .15s}
.gxw-name:hover:not([readonly]){background:#f9fafb;border-color:#eaecf0}
.gxw-name:focus{background:#fff;border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxw-name[readonly]{cursor:default}
.gxw-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.gxw-kind{flex:none;margin-top:5px;font-size:11px;font-weight:750;letter-spacing:.05em;text-transform:uppercase;border-radius:999px;padding:4px 10px;background:#eff8ff;color:#175cd3}
.gxw-kind[data-kind=organization_connection]{background:#fdf2fa;color:#c11574}
.gxw-sec{display:flex;flex-direction:column;gap:10px;min-width:0}
.gxw-sec>h4{display:flex;align-items:baseline;gap:6px;margin:0;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#667085}
.gxw-sec>h4 small{font-size:11.5px;font-weight:500;letter-spacing:0;text-transform:none;color:#98a2b3}
.gxw-input{width:100%;box-sizing:border-box;height:40px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:0 11px;font:inherit;font-size:14px;color:#101828;outline:none}
.gxw-input:focus,.gxw-select:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxw-select{height:36px;max-width:100%;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:0 8px;font:inherit;font-size:13px;color:#344054;outline:none}
.gxw-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.gxw-field>b{font-size:11.5px;font-weight:700;color:#667085;letter-spacing:.02em}
.gxw-chips{display:flex;flex-wrap:wrap;gap:8px}
.gxw-chip{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:6px 14px;font-size:13.5px!important;text-align:left;line-height:1.25;border:1px solid #d0d5dd;border-radius:999px;background:#fff;font:inherit;font-size:12.5px;font-weight:600;color:#344054;cursor:pointer}
.gxw-chip[aria-pressed=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary,#d93025)}
.gxw-chip.gxw-other{border-style:dashed;color:#475467}
.gxw-chip[aria-expanded=true]{border-color:var(--primary,#d93025);color:var(--primary,#d93025)}
.gxw-chip i{font-size:11px}
/* The kinds of each service: the service's name, then its kinds as small tags and a box to type a new one. */
/* Specialties: one panel per service it does, its suggestions in view at once and a box for your own. */
.gxw-kinds{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,190px),1fr));gap:10px}
.gxw-kindset{display:flex;flex-direction:column;gap:9px;min-width:0;padding:12px 12px 13px;border-radius:14px;background:#f9fafb;border:1px solid #f2f4f7}
.gxw-kindset>strong{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#101828;line-height:1.3}
.gxw-kindset>strong i{flex:none;width:24px;height:24px;border-radius:8px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary,#d93025);font-size:11px}
.gxw-kindset .gxw-chips{gap:6px}
.gxw-tag.gxw-more{border-style:dashed;border-color:#c4c9d2;background:transparent;color:#475467}
.gxw-tag{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 11px;border:1px solid #e4e7ec;border-radius:999px;background:#fff;font:inherit;font-size:12.5px;font-weight:600;color:#475467;cursor:pointer}
.gxw-tag:hover{border-color:#c4c9d2;color:#344054}
.gxw-tag[aria-pressed=true]{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
.gxw-tag i{font-size:10px}
.gxw-tag-new{width:120px;height:30px;box-sizing:border-box;border:1px dashed #d0d5dd;border-radius:999px;background:#fff;padding:0 11px;font:inherit;font-size:12.5px;color:#101828;outline:none}
.gxw-tag-new:focus{border-style:solid;border-color:var(--primary,#d93025)}
.gxw-person{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 6px 0 4px;border-radius:999px;background:#f2f4f7;font-size:13.5px;font-weight:600;color:#344054;max-width:100%}
.gxw-person>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxw-person[data-lead=true]{background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary,#d93025)}
.gxw-person>.gxw-avatar{width:28px;height:28px;background:#fff}
.gxw-people{display:flex;flex-wrap:wrap;gap:8px}
.gxw-person button{flex:none;width:22px;height:22px;border:0;border-radius:50%;background:transparent;color:#98a2b3;cursor:pointer;display:grid;place-items:center;font-size:11px}
.gxw-person button:hover{background:#e4e7ec;color:#475467}
.gxw-person [data-gxw-lead][aria-pressed=true]{color:var(--primary,#d93025)}
.gxw-person em{flex:none;font-style:normal;font-size:10.5px;font-weight:700;border-radius:999px;padding:1px 6px;background:#fff;color:#475467}
.gxw-pick{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 14px;border:1px solid #d0d5dd;border-radius:11px;background:#fff;font:inherit;font-size:13.5px;font-weight:650;color:#344054;cursor:pointer}
.gxw-pick[aria-expanded=true]{border-color:var(--primary,#d93025);color:var(--primary,#d93025)}
.gxw-pick i:last-child{font-size:10px;color:#98a2b3}
/* A dropdown of our own (people, other services): it opens in the card, under what opened it. */
.gxw-menu{display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 12px 32px rgba(16,24,40,.14)}
.gxw-menu input{height:34px;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:9px;padding:0 10px;font:inherit;font-size:13px;color:#101828;outline:none;min-width:0}
.gxw-menu input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
.gxw-menu ul{list-style:none;margin:0;padding:0;max-height:200px;overflow:auto}
.gxw-menu li button{display:flex;align-items:center;gap:9px;width:100%;padding:7px 8px;border:0;border-radius:8px;background:transparent;font:inherit;font-size:13px;color:#101828;text-align:left;cursor:pointer}
.gxw-menu li button:hover,.gxw-menu li button:focus-visible{background:#f2f4f7;outline:none}
.gxw-menu li button>span:last-child{display:flex;flex-direction:column;min-width:0}
.gxw-menu li small{font-size:11.5px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxw-avatar{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:#f2f4f7;color:#475467;font-size:10.5px;font-weight:750}
.gxw-menu-empty{padding:8px;font-size:12.5px;color:#667085}
.gxw-menu-new{display:flex;align-items:center;gap:9px;padding:8px;border:0;border-top:1px solid #f2f4f7;border-radius:0 0 8px 8px;background:transparent;font:inherit;font-size:13px;font-weight:650;color:var(--primary-readable,var(--primary,#d93025));cursor:pointer;text-align:left}
.gxw-menu-new:hover{background:rgba(var(--primary-rgb,217,48,37),.06)}
.gxw-newform{display:flex;flex-direction:column;gap:6px;padding:4px}
.gxw-newform>strong{font-size:12.5px;color:#344054}
.gxw-newform .gxw-actions{margin-top:2px;gap:6px}
.gxw-newform .gxw-btn{height:34px;padding:0 12px;font-size:13px;border-radius:9px}
.gxw-seg{display:flex;padding:3px;border-radius:11px;background:#f2f4f7;gap:2px}
.gxw-seg button{flex:1 1 0;min-width:0;height:32px;border:0;border-radius:8px;background:transparent;font:inherit;font-size:12.5px;font-weight:650;color:#475467;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gxw-seg button[aria-checked=true]{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.12)}
.gxw-rate{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gxw-money{display:inline-flex;align-items:center;height:38px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding-left:10px;font-weight:650;color:#667085}
.gxw-money input{width:84px;height:100%;border:0;background:transparent;padding:0 8px 0 4px;font:inherit;font-size:14px;color:#101828;outline:none}
.gxw-money:focus-within{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxw-unit{font-size:12.5px;color:#667085}
.gxw-same{font-size:12.5px;color:#475467;background:#f9fafb;border-radius:10px;padding:9px 11px}
.gxw-note{font-size:12.5px!important;color:#667085!important}
.gxw-sheet{align-self:flex-start;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px;border:1px dashed #d0d5dd;border-radius:10px;background:#fff;font:inherit;font-size:12.5px;font-weight:650;color:#344054;cursor:pointer}
.gxw-sheet:hover{background:#f9fafb}
.gxw-nav{position:absolute;top:50%;z-index:2;width:34px;height:34px;margin-top:-22px;border:1px solid #d0d5dd;border-radius:50%;background:#fff;color:#344054;box-shadow:0 4px 12px rgba(16,24,40,.12);cursor:pointer;display:grid;place-items:center}
.gxw-nav[hidden]{display:none}
.gxw-nav.prev{left:-12px}.gxw-nav.next{right:-12px}
.gxw-where{font-size:12px;color:#667085;text-align:center;min-height:16px}
.gxw-rows{display:flex;flex-direction:column;gap:8px}
.gxw-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff}
.gxw-row div{flex:1 1 auto;min-width:0}
.gxw-row strong{display:block;font-size:14px}
.gxw-row small{display:block;font-size:12px;color:#667085;margin-top:2px}
.gxw-row .gxw-avatar{width:34px;height:34px;font-size:12px}
.gxw-row>em{flex:none;font-style:normal;font-size:11.5px;font-weight:650;color:#667085}
/* What their crew members see: one switch per part of the app. */
.gxw-sees{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.gxw-see{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer}
.gxw-see>span:nth-child(2){flex:1 1 auto;min-width:0}
.gxw-see strong{display:block;font-size:13.5px}
.gxw-see small{display:block;font-size:12px;color:#667085;margin-top:2px;line-height:1.35}
.gxw-see[aria-checked=true]{border-color:var(--primary,#d93025);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxw-see .gxw-icon{width:36px;height:36px;font-size:15px}
.gxw-switch{flex:none;position:relative;width:34px;height:20px;border-radius:999px;background:#d0d5dd;transition:background .15s}
.gxw-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.2);transition:transform .15s}
.gxw-see[aria-checked=true] .gxw-switch{background:var(--primary,#d93025)}
.gxw-see[aria-checked=true] .gxw-switch::after{transform:translateX(14px)}
.gxw-see:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxw-done{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:#ecfdf3;color:#05603a}
.gxw-done i{font-size:22px}
.gxw-done p{color:#05603a;font-size:14px;font-weight:600}
.gxw-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
.gxw-spacer{flex:1 1 auto}
.gxw-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 18px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;font:inherit;font-size:14px;font-weight:650;color:#344054;cursor:pointer}
.gxw-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
.gxw-btn:disabled{opacity:.55;cursor:default}
.gxw-btn:focus-visible,.gxw-chip:focus-visible,.gxw-tag:focus-visible,.gxw-pick:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxw-busy{display:flex;align-items:center;gap:10px;min-height:120px;justify-content:center;color:#475467}
.gxw-error{color:#b42318!important;font-size:13px}
.gxw-error:empty{display:none}
/* A phone: one card at a time with the cards either side peeking in (the choices stack as every setup's do: .gxs-choices). */
@media(max-width:560px){.gxw-track,.gxw-track[data-more]{grid-auto-columns:86%;gap:12px}.gxw-card{padding:16px;gap:16px}.gxw-kinds{grid-template-columns:minmax(0,1fr)}.gxw-nav{display:none}.gxw-actions .gxw-btn{flex:1 1 auto}.gxw-sees{grid-template-columns:minmax(0,1fr)}}
@media(prefers-reduced-motion:reduce){.gxw *{transition:none!important}.gxw-track{scroll-behavior:auto}}
`;
function installStyle(){
  if (document.getElementById('gxw-css-gp66')) return;
  document.getElementById('gxw-css')?.remove();
  const style = document.createElement('style'); style.id = 'gxw-css-gp66'; style.textContent = css; document.head.append(style);
}

/**
 * Whether an assignee the organization has is part of its workforce: a group of a type that does the work (the step's
 * `work_group_types`, library data; a group with no type counts), an outside company with no type the step names as
 * another kind of partner (`other_company_types`: haul-off, supplier delivery). The rest (a sales team, a dumpster
 * company) are not shown, counted or saved here.
 */
export function inWorkforce(options, entry){
  const types = array(entry?.type_ids).length ? array(entry.type_ids) : [clean(entry?.type_id)].filter(Boolean);
  if (entry?.kind === 'resource_group') { const work = array(object(options).work_group_types); return !work.length || !types.length || types.some((id) => work.includes(id)); }
  const other = array(object(options).other_company_types);
  return !types.some((id) => other.includes(id));
}
/** Which kinds the answer to "who does the work" asks for. */
export function kindsFor(workforce){
  const id = clean(workforce);
  return { groups: id === 'crews' || id === 'crews_and_subs' || id === 'just_me', companies: id === 'subcontractors' || id === 'crews_and_subs' };
}
/**
 * How a new one is paid at first: the step's `pay_defaults` (library data, the first whose `industry_sets` the company is
 * in, or one with none), as long as the company can be paid that way (a piece rate needs roofing work); else hourly.
 */
export function defaultPay(options, profile, kind){
  const sets = array(object(profile).industry_sets), roofing = array(object(profile).work_kinds).includes('roofing');
  const rules = array(object(options).pay_defaults);
  const fits = (rule) => (!array(rule.industry_sets).length || array(rule.industry_sets).some((id) => sets.includes(id))) && (!array(rule.kinds).length || array(rule.kinds).includes(kind));
  const rule = rules.find(fits) || {};
  const method = clean(rule.method);
  if (method === 'per_measurement' && roofing) return { method, rate: 0, measurement: clean(rule.measurement) || 'roof.squares' };
  if (method === 'per_job') return { method, rate: 0 };
  return { method: 'hourly', rate: 0 };
}
/** A card's pay, following "same as" to the one it copies (never round in a circle). */
export function payOf(rows, row, seen = new Set()){
  if (!row || seen.has(row.key)) return null;
  seen.add(row.key);
  if (row.same) { const other = rows.find((entry) => entry.key === row.same); if (other) return payOf(rows, other, seen); }
  return row.locked || row.sheet ? null : row.pay;
}
/** One of each kind, however it was typed, for the services the card does. */
export function tagsFor(row){
  const out = {};
  for (const service of array(row?.service_ids)) {
    const seen = new Set(), kept = [];
    for (const tag of array(object(row?.service_tags)[service]).map((entry) => clean(entry).replace(/\s+/g, ' ')).filter(Boolean)) if (!seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); kept.push(tag); }
    if (kept.length) out[service] = kept;
  }
  return out;
}
/**
 * The crews' App experience settings from what the person chose they see (the step's `crew_apps`: each choice shows
 * or hides its apps, or sets one app option), as operations.workforce.setup.apply takes them.
 */
export function appsFor(choices, chosen){
  const apps = {};
  for (const choice of array(choices)) {
    const on = object(chosen)[choice.id] === true;
    for (const id of array(choice.apps)) apps[id] = { ...object(apps[id]), visible: on };
    const option = object(choice.option);
    if (option.app && option.key) apps[option.app] = { ...object(apps[option.app]), options: { ...object(object(apps[option.app]).options), [option.key]: on } };
  }
  return apps;
}
/** What the setup sends to operations.workforce.setup.apply for the cards it shows. Someone not added yet is left out. */
export function applyInput(rows, extra = {}){
  return {
    include_labor: true,
    labor: { assignees: rows.map((row) => {
      const pay = payOf(rows, row);
      const members = row.kind === GROUP ? array(row.member_user_ids).filter((id) => !isPending(id) && !array(row.saved_members).includes(id)) : [];
      const lead = row.kind === GROUP && row.lead_user_id && !isPending(row.lead_user_id) && array(row.member_user_ids).includes(row.lead_user_id) ? row.lead_user_id : '';
      const apps = row.kind === GROUP && extra.apps && Object.keys(extra.apps).length ? extra.apps : null;
      return {
        ...(row.ref ? { ref: row.ref } : {}), kind: row.kind, name: clean(row.name),
        service_ids: [...row.service_ids],
        service_tags: tagsFor(row),
        ...(members.length ? { member_user_ids: members } : {}),
        ...(lead && lead !== row.saved_lead ? { lead_user_id: lead } : {}),
        ...(apps ? { apps } : {}),
        ...(pay && Number(pay.rate) > 0 && !row.locked && !row.sheet ? { pay: { method: pay.method, rate: Number(pay.rate), ...(pay.method === 'per_measurement' ? { measurement: pay.measurement || 'roof.squares' } : {}) } } : {})
      };
    }) }
  };
}
/** How well a service matches what was typed in Other's search: its name, then the words people use for it. 0 is none. */
export function matchService(entry, label, query){
  const q = fold(query); if (!q) return 1;
  const name = fold(label), terms = array(entry?.terms).map(fold);
  if (name === q || terms.includes(q)) return 100;
  if (name.startsWith(q)) return 80;
  if (terms.some((term) => term.startsWith(q))) return 70;
  const words = [name, ...terms].join(' ').split(' ');
  return q.split(' ').every((token) => words.some((word) => word.startsWith(token))) ? 40 : 0;
}

export function mount(el, ctx){
  installStyle();
  const { esc } = ctx;
  const L = (key, fallback, values) => { let text = ctx.L(key, fallback); for (const [name, value] of Object.entries(values || {})) text = text.split(`{${name}}`).join(String(value)); return text; };
  const copy = (entry) => typeof entry === 'string' ? entry : clean(ctx.L(entry, object(entry).text)) || clean(object(entry).text);
  const word = (path, fallback) => clean(window.PlatformTerminology?.get?.(path, fallback) || window.Portal?.terminology?.get?.(path, fallback)) || fallback;
  const crew = word('workforce.resource_group_singular', 'Crew'), crews = word('workforce.resource_group_plural', 'Crews');
  const sub = word('workforce.organization_connection_singular', 'Subcontractor'), subs = word('workforce.organization_connection_plural', 'Subcontractors');
  const member = word('workforce.resource_group_member_singular', `${crew} member`);
  const orgId = String(window.__APP?.userOrgId || window.Portal?.currentUser?.orgId || ctx.orgId || '');
  const me = { id: clean(window.Portal?.currentUser?.id || window.__APP?.userId), name: clean(window.Portal?.currentUser?.name || window.__APP?.userName) };
  const options = object(ctx.options);
  let alive = true, busy = false, page = 0, status = {}, profile = {}, workforce = '', savedWorkforce = '', rows = [], counts = {}, result = null;
  // Someone added here who is not in the organization yet (added when the setup is saved), services found under Other,
  // kinds typed on any card (offered on the others), and the answers to the invite pages.
  let newPeople = [], extraServices = [], typedTags = {}, invite = '', seen = null, invited = null, catalog = null, menu = null;
  // The services whose specialties are open for picking, by card.
  const kindsOpen = new Set();
  const pages = ['who', 'count', 'work', 'pay', 'invite', 'see', 'done'];

  const errorLine = '<p class="gxw-error" role="alert" data-gxw-error></p>';
  const fail = (error) => { const node = el.querySelector('[data-gxw-error]'); if (node) node.textContent = clean(error?.message) || L('gx_wfs_error', 'That didn’t work. Try again.'); };
  const heading = el.closest('.gxs-step')?.querySelector('.gxs-titlebar h2'), stepHeading = heading?.innerHTML || '';
  function title(value){ ctx.setTitle?.(value); if (heading) heading.innerHTML = value ? esc(value) : stepHeading; }
  const icon = (name, more = '') => `<span class="gxw-icon${more ? ` ${more}` : ''}" aria-hidden="true"><i class="fas ${esc(name)}"></i></span>`;
  const kindWord = (kind) => kind === GROUP ? crew : sub;
  const catalogService = (id) => array(catalog?.services).find((entry) => entry.id === id);
  // The company's services, then any a card does that the profile left out (found under Other, or saved before).
  const services = () => [...array(profile.services), ...extraServices.filter((entry) => !array(profile.services).some((own) => own.id === entry.id))];
  const serviceLabel = (id) => services().find((entry) => entry.id === id)?.label || (catalogService(id) ? copy(catalogService(id).label) : id);
  const people = () => [...array(status.people), ...newPeople];
  const personOf = (id) => people().find((entry) => entry.id === id);
  const personName = (id) => personOf(id)?.name || (id === me.id ? me.name : id);
  const initials = (name) => clean(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  const measurements = () => array(status.measurements);
  const roofing = () => array(profile.work_kinds).includes('roofing');
  const can = () => object(status.can);
  const wanted = () => kindsFor(workforce);
  // Crews first, then subcontractors, each in the order they were added.
  const shown = () => [...rows.filter((row) => row.kind === GROUP && wanted().groups), ...rows.filter((row) => row.kind === COMPANY && wanted().companies)];
  const existingOf = (kind) => rows.filter((row) => row.kind === kind && row.existing);
  // The crews' people who have not joined yet and can be emailed: who the invite page is about.
  const invitees = () => {
    const ids = [...new Set(shown().filter((row) => row.kind === GROUP).flatMap((row) => row.member_user_ids))];
    return ids.map(personOf).filter((person) => person && person.email && (person.pending || person.status === 'invited'));
  };
  const crewChoices = () => array(object(options).crew_apps).filter((choice) => {
    const apps = [...array(choice.apps), object(choice.option).app].filter(Boolean);
    return apps.length && !apps.every((id) => array(status.apps_off).includes(id));
  });
  const skip = (name) => (name === 'count' && workforce === 'just_me')
    || ((name === 'invite' || name === 'see') && (!can().invite || !invitees().length))
    || (name === 'see' && (invite !== 'yes' || !crewChoices().length));
  const nextPage = (from) => { let at = from + 1; while (at < pages.length - 1 && skip(pages[at])) at += 1; return pages[at]; };
  function report(){ ctx.change?.({ workforce, ...applyInput(shown(), { apps: invite === 'yes' && seen ? appsFor(crewChoices(), seen) : null }) }, shown().map((row) => clean(row.name)).join(', ')); }
  function go(to){
    const step = to < page ? -1 : 1;
    let next = Math.max(0, Math.min(to, pages.length - 1));
    while (next > 0 && next < pages.length - 1 && skip(pages[next])) next += step;
    page = Math.max(0, Math.min(next, pages.length - 1)); menu = null; draw(); el.closest('.gxs-step')?.scrollTo?.({ top: 0 }); ctx.syncBack?.();
  }
  const backButton = () => `<button type="button" class="gxw-btn" data-gxw-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>`;
  const nextButton = (label) => `<button type="button" class="gxw-btn primary" data-gxw-next>${esc(label || L('gx_ui_continue', 'Continue'))}</button>`;
  const saveButton = () => `<button type="button" class="gxw-btn primary" data-gxw-apply>${esc(L('gx_wfs_apply', 'Save'))}</button>`;

  // ── Who does the work at your company? ─────────────────────────────────
  // The shared setup step's own part (GP-65): the same question, tiles and copy as the appointment setup asks.
  const STEP = new URL('../setup-steps/company-profile.js?v=20261119-gp65', import.meta.url).href;
  let whoStep = null;
  function drawWho(){
    title(L('gx_step_company_workforce_title', 'Who does most of the work?'));
    el.innerHTML = `<div class="gxw" data-gxw-page="who">
      <div data-gxw-who></div>
      ${errorLine}
      <div class="gxw-actions"><span class="gxw-spacer"></span>${nextButton()}</div>
    </div>`;
    const holder = el.querySelector('[data-gxw-who]');
    import(STEP).then((module) => {
      if (!alive || !holder.isConnected) return;
      whoStep = module.mount(holder, { ...ctx, options: { part: 'workforce' }, answer: workforce ? { workforce } : {},
        change(patch){
          const next = clean(patch?.workforce);
          if (!next || next === workforce) return;
          workforce = next; el.querySelector('[data-gxw-error]').textContent = ''; fitRows(); report();
        },
        advance: () => el.querySelector('[data-gxw-next]')?.click() });
    }).catch(fail);
    el.querySelector('[data-gxw-next]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!workforce) { fail({ message: L('gx_wfs_who_required', 'Choose who does the work to continue.') }); return; }
      if (busy) return;
      // The answer is the company profile's, kept once for every setup that needs it.
      if (workforce !== savedWorkforce) {
        busy = true; button.disabled = true;
        try {
          await window.PlatformAPI.publication.invoke(orgId, 'company-profile.save', { scope: 'organization', organizationId: orgId }, { workforce }, { idempotencyKey: `operations.workforce.setup:who:${orgId}:${crypto.randomUUID()}` });
          savedWorkforce = workforce;
        } catch (error) { fail(error); return; } finally { busy = false; if (button.isConnected) button.disabled = false; }
      }
      if (!alive) return;
      go(page + 1);
    });
  }

  // ── How many do you have? ──────────────────────────────────────────────
  const defaultName = (kind, at) => {
    const used = new Set(rows.map((row) => clean(row.name).toLowerCase()));
    for (let n = at; n < at + 200; n += 1) {
      const letter = n < 26 ? String.fromCharCode(65 + n) : String(n + 1);
      const name = `${kindWord(kind)} ${letter}`;
      if (!used.has(name.toLowerCase())) return name;
    }
    return `${kindWord(kind)} ${at + 1}`;
  };
  function newRow(kind){
    const own = workforce === 'just_me' && kind === GROUP && !rows.some((row) => row.kind === GROUP);
    return { key: `new:${kind}:${crypto.randomUUID().slice(0, 8)}`, kind, existing: false, name: own && me.name ? me.name : defaultName(kind, 0),
      service_ids: array(profile.services).map((entry) => entry.id), service_tags: {}, member_user_ids: own && me.id ? [me.id] : [], saved_members: [], lead_user_id: '', saved_lead: '', pay: defaultPay(options, profile, kind), same: '' };
  }
  // How many of a kind were asked for: what was said (0 is an answer), else one to start from.
  const countOf = (kind) => { const value = Number(counts[kind]); return Number.isFinite(value) ? value : 1; };
  /** Adds or takes away new cards so each kind has as many as was said; the ones already set up are always kept. */
  function fitRows(){
    for (const kind of [GROUP, COMPANY]) {
      const on = kind === GROUP ? wanted().groups : wanted().companies;
      const want = on ? Math.max(existingOf(kind).length, workforce === 'just_me' ? 1 : countOf(kind)) : existingOf(kind).length;
      let have = rows.filter((row) => row.kind === kind);
      while (have.length < want) { rows.push(newRow(kind)); have = rows.filter((row) => row.kind === kind); }
      while (have.length > want) { const last = [...have].reverse().find((row) => !row.existing); if (!last) break; rows = rows.filter((row) => row !== last); rows.forEach((row) => { if (row.same === last.key) row.same = ''; }); have = rows.filter((row) => row.kind === kind); }
      if (on) counts[kind] = have.length;
    }
  }
  let counting = false;
  function drawCount(){
    title(L('gx_wfs_count_title', 'How many do you have?'));
    const line = (kind, label, hint) => {
      const min = existingOf(kind).length, value = rows.filter((row) => row.kind === kind).length;
      const have = existingOf(kind).length;
      return `<div class="gxw-count" data-gxw-count="${kind}">${icon(kind === GROUP ? 'fa-users' : 'fa-handshake')}<span class="gxw-count-text"><strong>${esc(label)}</strong><small>${esc(have ? L('gx_wfs_count_have', '{n} already set up, kept as they are', { n: have }) : hint)}</small></span>
        <span class="gxw-step"><button type="button" data-gxw-minus aria-label="${esc(L('gx_wfs_fewer', 'One fewer'))}" ${value <= min ? 'disabled' : ''}>−</button><input type="number" inputmode="numeric" min="${min}" max="${MAX_EACH}" value="${value}" aria-label="${esc(label)}"><button type="button" data-gxw-plus aria-label="${esc(L('gx_wfs_more', 'One more'))}" ${value >= MAX_EACH ? 'disabled' : ''}>+</button></span></div>`;
    };
    el.innerHTML = `<div class="gxw" data-gxw-page="count">
      <p>${esc(L('gx_wfs_count_lead', 'Count each team that goes out on its own. You’ll name them next.'))}</p>
      <div class="gxw-counts">
        ${wanted().groups ? line(GROUP, crews, L('gx_wfs_count_crews_hint', 'Teams of your own people')) : ''}
        ${wanted().companies ? line(COMPANY, subs, L('gx_wfs_count_subs_hint', 'Outside companies that do the work for you')) : ''}
      </div>
      ${errorLine}
      <div class="gxw-actions">${backButton()}<span class="gxw-spacer"></span>${nextButton()}</div>
    </div>`;
    el.querySelectorAll('[data-gxw-count]').forEach((holder) => {
      const kind = holder.dataset.gxwCount, input = holder.querySelector('input');
      const set = (value) => {
        // Redrawing takes the focused box away, and a changed box fires its change again as it goes: once is enough.
        if (counting) return;
        const min = existingOf(kind).length, number = Math.round(Number(value));
        counts[kind] = Math.max(min, Math.min(MAX_EACH, Number.isFinite(number) ? number : min));
        counting = true;
        try { fitRows(); report(); drawCount(); } finally { counting = false; }
        el.querySelector(`[data-gxw-count="${kind}"] input`)?.focus();
      };
      holder.querySelector('[data-gxw-minus]').addEventListener('click', () => set(Number(input.value) - 1));
      holder.querySelector('[data-gxw-plus]').addEventListener('click', () => set(Number(input.value) + 1));
      input.addEventListener('change', () => set(input.value));
    });
    el.querySelector('[data-gxw-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxw-next]').addEventListener('click', () => {
      // A kind can be 0 (subcontractors the company uses, none yet), but something has to be set up.
      if (!shown().length) { fail({ message: L('gx_wfs_count_required', 'Count at least one to continue.') }); return; }
      go(page + 1);
    });
  }

  // ── The cards, side by side or as a carousel ───────────────────────────
  function deck(cards){
    return `<div class="gxw-deck"><button type="button" class="gxw-nav prev" data-gxw-nav="-1" aria-label="${esc(L('gx_wfs_previous', 'Previous'))}" hidden><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
      <div class="gxw-track" style="--n:${Math.max(1, Math.min(3, cards.length))}"${cards.length > 3 ? ' data-more' : ''}>${cards.join('')}</div>
      <button type="button" class="gxw-nav next" data-gxw-nav="1" aria-label="${esc(L('gx_wfs_next', 'Next'))}" hidden><i class="fas fa-chevron-right" aria-hidden="true"></i></button></div>
      <div class="gxw-where" aria-live="polite"></div>`;
  }
  function wireDeck(){
    const track = el.querySelector('.gxw-track'); if (!track) return;
    const prev = el.querySelector('[data-gxw-nav="-1"]'), next = el.querySelector('[data-gxw-nav="1"]'), where = el.querySelector('.gxw-where');
    const update = () => {
      const more = track.scrollWidth - track.clientWidth > 4;
      prev.hidden = !more || track.scrollLeft < 4; next.hidden = !more || track.scrollLeft > track.scrollWidth - track.clientWidth - 4;
      // The cards wholly in view (the ones peeking in at the sides are not counted).
      const box = track.getBoundingClientRect(), cards = [...track.children];
      const whole = cards.map((card, at) => ({ at, rect: card.getBoundingClientRect() })).filter(({ rect }) => rect.left >= box.left - 2 && rect.right <= box.right + 2).map(({ at }) => at);
      const first = whole.length ? whole[0] : 0, last = whole.length ? whole[whole.length - 1] + 1 : 1;
      where.textContent = !more ? '' : last === first + 1 ? L('gx_wfs_where_one', '{at} of {n}', { at: first + 1, n: cards.length }) : L('gx_wfs_where', '{from}–{to} of {n}', { from: first + 1, to: last, n: cards.length });
    };
    const step = (direction) => { const width = track.firstElementChild?.getBoundingClientRect().width || track.clientWidth; track.scrollBy({ left: direction * (width + 16), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
    prev.addEventListener('click', () => step(-1)); next.addEventListener('click', () => step(1));
    track.addEventListener('scroll', update, { passive: true });
    // A field tabbed into on a card out of view brings that card in, sideways only (a click is never moved from under the pointer).
    track.addEventListener('focusin', (event) => { if (event.target.matches?.(':focus-visible')) bringIn(track, event.target.closest('.gxw-card')); });
    requestAnimationFrame(update);
  }
  function bringIn(track, card){
    if (!track || !card) return;
    const box = track.getBoundingClientRect(), rect = card.getBoundingClientRect();
    if (rect.left < box.left) track.scrollLeft -= box.left - rect.left + 2;
    else if (rect.right > box.right) track.scrollLeft += rect.right - box.right + 2;
  }
  const kindTag = (row) => `<span class="gxw-kind" data-kind="${row.kind}">${esc(kindWord(row.kind))}</span>`;
  const head = (row) => `<header><strong title="${esc(row.name)}">${esc(row.name)}</strong>${kindTag(row)}</header>`;

  // ── Name each one and say what they do ─────────────────────────────────
  // The kinds offered for a service: the library's (the step's `service_tags`), the ones the organization's crews and
  // subcontractors already do, and any typed here.
  const kindsOffered = (service, row) => {
    const all = [...array(object(options.service_tags)[service]).map(copy), ...array(object(status.service_tags_used)[service]), ...array(typedTags[service]), ...array(object(row.service_tags)[service])];
    const once = new Set(); return all.map(clean).filter((tag) => tag && !once.has(tag.toLowerCase()) && once.add(tag.toLowerCase()));
  };
  const hasTag = (row, service, tag) => array(object(row.service_tags)[service]).some((entry) => entry.toLowerCase() === tag.toLowerCase());
  function otherMenu(row){
    const query = menu?.query || '';
    const taken = new Set(services().map((entry) => entry.id));
    const found = array(catalog?.services).filter((entry) => !taken.has(entry.id)).map((entry) => ({ entry, score: matchService(entry, copy(entry.label), query) })).filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || copy(a.entry.label).localeCompare(copy(b.entry.label))).slice(0, 8);
    return `<div class="gxw-menu" data-gxw-menu>
      <input type="search" data-gxw-find value="${esc(query)}" placeholder="${esc(L('gx_wfs_other_search', 'Search, for example “gutters”'))}" aria-label="${esc(L('gx_wfs_other_label', 'Search other kinds of work'))}" autocomplete="off" spellcheck="false">
      ${!catalog ? `<div class="gxw-menu-empty">${esc(L('gx_wfs_loading', 'Loading…'))}</div>` : found.length ? `<ul role="listbox">${found.map(({ entry }) => `<li><button type="button" role="option" data-gxw-service-add="${esc(entry.id)}"><span class="gxw-avatar"><i class="fas fa-plus" aria-hidden="true"></i></span><span>${esc(copy(entry.label))}</span></button></li>`).join('')}</ul>` : `<div class="gxw-menu-empty">${esc(L('gx_wfs_other_none', 'Nothing matches. Try another word.'))}</div>`}
    </div>`;
  }
  function peopleMenu(row){
    if (menu?.mode === 'new') {
      const draft = object(menu.draft);
      return `<div class="gxw-menu" data-gxw-menu><form class="gxw-newform" data-gxw-newform novalidate>
        <strong>${esc(L('gx_wfs_member_new', 'New {member_lower}', { member_lower: member.toLowerCase() }))}</strong>
        <input class="gxw-input" name="name" value="${esc(draft.name || '')}" maxlength="200" placeholder="${esc(L('gx_wfs_member_name', 'Full name'))}" aria-label="${esc(L('gx_wfs_member_name', 'Full name'))}" autocomplete="off">
        <input class="gxw-input" name="email" type="email" value="${esc(draft.email || '')}" maxlength="320" placeholder="${esc(L('gx_wfs_member_email', 'Email'))}" aria-label="${esc(L('gx_wfs_member_email', 'Email'))}" autocomplete="off">
        <p class="gxw-error" role="alert" data-gxw-newerror></p>
        <div class="gxw-actions"><button type="button" class="gxw-btn" data-gxw-newcancel>${esc(L('gx_ui_cancel', 'Cancel'))}</button><span class="gxw-spacer"></span><button type="submit" class="gxw-btn primary">${esc(L('gx_wfs_member_new_add', 'Add'))}</button></div>
      </form></div>`;
    }
    const query = fold(menu?.query || '');
    const others = people().filter((person) => !row.member_user_ids.includes(person.id));
    const found = others.filter((person) => !query || fold(`${person.name} ${person.email || ''}`).split(' ').some((word) => word.startsWith(query)) || fold(person.name).includes(query));
    return `<div class="gxw-menu" data-gxw-menu>
      ${others.length > 6 ? `<input type="search" data-gxw-find value="${esc(menu?.query || '')}" placeholder="${esc(L('gx_wfs_member_search', 'Search people'))}" aria-label="${esc(L('gx_wfs_member_search', 'Search people'))}" autocomplete="off" spellcheck="false">` : ''}
      ${found.length ? `<ul role="listbox">${found.map((person) => `<li><button type="button" role="option" data-gxw-member="${esc(person.id)}"><span class="gxw-avatar">${esc(initials(person.name))}</span><span>${esc(person.name)}${person.email ? `<small>${esc(person.email)}</small>` : ''}</span></button></li>`).join('')}</ul>` : `<div class="gxw-menu-empty">${esc(others.length ? L('gx_wfs_member_none_match', 'Nobody matches.') : L('gx_wfs_member_none', 'Everyone is on it already.'))}</div>`}
      ${can().add_people ? `<button type="button" class="gxw-menu-new" data-gxw-newperson><span class="gxw-avatar"><i class="fas fa-user-plus" aria-hidden="true"></i></span>${esc(L('gx_wfs_member_new', 'New {member_lower}', { member_lower: member.toLowerCase() }))}</button>` : ''}
    </div>`;
  }
  // How many of a service's suggestions are in view before "more".
  const SHOWN_KINDS = 4;
  function kindPanel(row, entry){
    // A service's specialties: the ones picked, then the first few suggestions; "more" shows the rest. Your own are typed in.
    const opened = kindsOpen.has(`${row.key}|${entry.id}`), offered = kindsOffered(entry.id, row);
    const rest = offered.filter((tag) => !hasTag(row, entry.id, tag));
    const shown = [...offered.filter((tag) => hasTag(row, entry.id, tag)), ...(opened ? rest : rest.slice(0, SHOWN_KINDS))];
    const hidden = opened ? 0 : rest.length - Math.min(rest.length, SHOWN_KINDS);
    const tag = (text) => { const on = hasTag(row, entry.id, text); return `<button type="button" class="gxw-tag" data-gxw-tag="${esc(text)}" aria-pressed="${on}"><i class="fas ${on ? 'fa-check' : 'fa-plus'}" aria-hidden="true"></i>${esc(text)}</button>`; };
    return `<div class="gxw-kindset" data-gxw-kinds="${esc(entry.id)}"><strong>${esc(entry.label)}</strong><div class="gxw-chips">${shown.map(tag).join('')}${hidden || opened ? `<button type="button" class="gxw-tag gxw-more" data-gxw-kinds-open aria-expanded="${opened}">${esc(opened ? L('gx_wfs_kind_fewer', 'Fewer') : L('gx_wfs_kind_more_n', '{n} more', { n: hidden }))}</button>` : ''}<input class="gxw-tag-new" data-gxw-tag-new maxlength="60" placeholder="${esc(L('gx_wfs_kind_add', '+ Your own'))}" aria-label="${esc(L('gx_wfs_kind_add_label', 'Add a kind of {service}', { service: entry.label.toLowerCase() }))}" enterkeyhint="done"></div></div>`;
  }
  function personChip(row, id, leadOn){
    const lead = row.lead_user_id === id, saved = array(row.saved_members).includes(id), name = personName(id);
    const flag = leadOn || lead ? `<button type="button" data-gxw-lead="${esc(id)}" aria-pressed="${lead}" title="${esc(lead ? L('gx_wfs_lead', 'In charge') : L('gx_wfs_lead_make', 'Make them the one in charge'))}" aria-label="${esc(L('gx_wfs_lead_label', '{name} is in charge', { name }))}"><i class="${lead ? 'fas' : 'far'} fa-flag" aria-hidden="true"></i></button>` : '';
    const remove = saved ? '' : `<button type="button" data-gxw-unmember="${esc(id)}" aria-label="${esc(L('gx_wfs_member_remove', 'Take off'))} ${esc(name)}"><i class="fas fa-xmark" aria-hidden="true"></i></button>`;
    return `<span class="gxw-person" data-gxw-person="${esc(id)}" data-lead="${lead}"><span class="gxw-avatar" aria-hidden="true">${esc(initials(name))}</span><span>${esc(name)}</span>${personOf(id)?.pending ? `<em>${esc(L('gx_wfs_member_new_badge', 'New'))}</em>` : ''}${flag}${remove}${!flag && !remove ? '<span style="width:6px"></span>' : ''}</span>`;
  }
  function workCard(row){
    const chosen = new Set(row.service_ids);
    const open = (kind) => menu?.row === row.key && menu.kind === kind;
    const leadOn = row.member_user_ids.length > 1;
    const chosenServices = services().filter((entry) => chosen.has(entry.id));
    return `<article class="gxw-card" data-gxw-card="${esc(row.key)}">
      <header><label class="gxw-title"><span class="gxw-sr">${esc(L('gx_wfs_name', 'Name'))}</span><input class="gxw-name" data-gxw-name value="${esc(row.name)}" maxlength="300" placeholder="${esc(L('gx_wfs_name', 'Name'))}" ${row.existing ? 'readonly title="' + esc(L('gx_wfs_name_people', 'Rename it in People')) + '"' : ''}></label>${kindTag(row)}</header>
      <section class="gxw-sec"><h4>${esc(L('gx_wfs_does', 'What they do'))}</h4><div class="gxw-chips">${services().map((entry) => `<button type="button" class="gxw-chip" data-gxw-service="${esc(entry.id)}" aria-pressed="${chosen.has(entry.id)}">${chosen.has(entry.id) ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}${esc(entry.label)}</button>`).join('')}<button type="button" class="gxw-chip gxw-other" data-gxw-other aria-expanded="${open('other')}"><i class="fas fa-magnifying-glass" aria-hidden="true"></i>${esc(L('gx_wfs_other', 'Other'))}</button></div>
        ${open('other') ? otherMenu(row) : ''}</section>
      ${chosenServices.length ? `<section class="gxw-sec"><h4>${esc(L('gx_wfs_kinds_title', 'Specialties'))}<small>${esc(L('gx_wfs_optional', 'optional'))}</small></h4><div class="gxw-kinds">${chosenServices.map((entry) => kindPanel(row, entry)).join('')}</div></section>` : ''}
      ${row.kind === GROUP ? `<section class="gxw-sec"><h4>${esc(L('gx_wfs_members_title', 'Who’s on it'))}<small>${esc(L('gx_wfs_optional', 'optional'))}</small></h4>
        ${row.member_user_ids.length ? `<div class="gxw-people">${row.member_user_ids.map((id) => personChip(row, id, leadOn)).join('')}</div>` : ''}
        ${leadOn && !row.lead_user_id ? `<p class="gxw-note">${esc(L('gx_wfs_lead_hint', 'Tap the flag next to whoever is in charge.'))}</p>` : ''}
        <button type="button" class="gxw-pick" data-gxw-pick aria-haspopup="listbox" aria-expanded="${open('people')}"><i class="fas fa-user-plus" aria-hidden="true"></i>${esc(L('gx_wfs_member_add', 'Add someone'))}<i class="fas fa-chevron-down" aria-hidden="true"></i></button>
        ${open('people') ? peopleMenu(row) : ''}
      </section>` : ''}
    </article>`;
  }
  function drawWork(focus){
    title(L('gx_wfs_work_title', 'Name each one and say what they do'));
    const list = shown();
    const left = el.querySelector('[data-gxw-page="work"] .gxw-track')?.scrollLeft || 0;
    el.innerHTML = `<div class="gxw" data-gxw-page="work">
      <p>${esc(services().length ? L('gx_wfs_work_lead', 'Give each one a name your team uses and pick the work they do. You can add who is on a {crew_lower} now or later.', { crew_lower: crew.toLowerCase() }) : L('gx_wfs_work_lead_plain', 'Give each one a name your team uses.'))}</p>
      ${deck(list.map(workCard))}
      ${errorLine}
      <div class="gxw-actions">${backButton()}<span class="gxw-spacer"></span>${nextButton()}</div>
    </div>`;
    const track = el.querySelector('.gxw-track'); if (track && focus !== undefined) track.scrollLeft = left;
    const rowOf = (node) => rows.find((row) => row.key === node.closest('[data-gxw-card]')?.dataset.gxwCard);
    const redraw = (row, selector) => { drawWork(selector ? `[data-gxw-card="${CSS.escape(row.key)}"] ${selector}` : ''); };
    el.querySelectorAll('[data-gxw-name]').forEach((input) => input.addEventListener('input', () => { const row = rowOf(input); if (row && !row.existing) { row.name = input.value; report(); } }));
    el.querySelectorAll('[data-gxw-service]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button), id = button.dataset.gxwService; if (!row) return;
      row.service_ids = row.service_ids.includes(id) ? row.service_ids.filter((entry) => entry !== id) : [...row.service_ids, id];
      report(); redraw(row, `[data-gxw-service="${CSS.escape(id)}"]`);
    }));
    // Other: a search of every kind of work, for one the company profile left out.
    el.querySelectorAll('[data-gxw-other]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button); if (!row) return;
      menu = menu?.row === row.key && menu.kind === 'other' ? null : { row: row.key, kind: 'other', query: '' };
      if (menu && !catalog) loadCatalog().then(() => { if (alive && menu?.kind === 'other' && pages[page] === 'work') redraw(row, '[data-gxw-find]'); });
      redraw(row, menu ? '[data-gxw-find]' : '[data-gxw-other]');
    }));
    el.querySelectorAll('[data-gxw-service-add]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button), entry = catalogService(button.dataset.gxwServiceAdd); if (!row || !entry) return;
      if (!services().some((own) => own.id === entry.id)) extraServices.push({ id: entry.id, label: copy(entry.label) });
      row.service_ids = [...new Set([...row.service_ids, entry.id])];
      menu = null; report(); redraw(row, `[data-gxw-service="${CSS.escape(entry.id)}"]`);
    }));
    // The kinds of a service: pick one offered, or type a new one (Enter or a comma adds it).
    el.querySelectorAll('[data-gxw-tag]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button), service = button.closest('[data-gxw-kinds]')?.dataset.gxwKinds, tag = button.dataset.gxwTag; if (!row || !service) return;
      const now = array(object(row.service_tags)[service]);
      row.service_tags = { ...object(row.service_tags), [service]: hasTag(row, service, tag) ? now.filter((entry) => entry.toLowerCase() !== tag.toLowerCase()) : [...now, tag] };
      report(); redraw(row, `[data-gxw-kinds="${CSS.escape(service)}"] [data-gxw-tag="${CSS.escape(tag)}"]`);
    }));
    el.querySelectorAll('[data-gxw-kinds-open]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button), service = button.closest('[data-gxw-kinds]')?.dataset.gxwKinds; if (!row || !service) return;
      const id = `${row.key}|${service}`, opening = !kindsOpen.has(id);
      if (opening) kindsOpen.add(id); else kindsOpen.delete(id);
      redraw(row, `[data-gxw-kinds="${CSS.escape(service)}"] [data-gxw-kinds-open]`);
    }));
    el.querySelectorAll('[data-gxw-tag-new]').forEach((input) => {
      const add = () => {
        const row = rowOf(input), service = input.closest('[data-gxw-kinds]')?.dataset.gxwKinds, tag = clean(input.value.replace(/,/g, ' ')).replace(/\s+/g, ' ').slice(0, 60);
        if (!row || !service || !tag) return false;
        if (!hasTag(row, service, tag)) row.service_tags = { ...object(row.service_tags), [service]: [...array(object(row.service_tags)[service]), tag] };
        typedTags[service] = [...new Set([...array(typedTags[service]), tag])];
        report(); redraw(row, `[data-gxw-kinds="${CSS.escape(service)}"] [data-gxw-tag-new]`); return true;
      };
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); } });
      input.addEventListener('blur', () => { if (clean(input.value)) setTimeout(() => { if (input.isConnected) add(); }, 0); });
    });
    // Who is on it: our own dropdown of the organization's people, with someone new at the bottom.
    el.querySelectorAll('[data-gxw-pick]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button); if (!row) return;
      menu = menu?.row === row.key && menu.kind === 'people' ? null : { row: row.key, kind: 'people', query: '' };
      redraw(row, menu ? '[data-gxw-find],[data-gxw-member]' : '[data-gxw-pick]');
    }));
    el.querySelectorAll('[data-gxw-find]').forEach((input) => input.addEventListener('input', () => {
      const row = rowOf(input); if (!row || !menu) return;
      menu.query = input.value; const at = input.selectionStart;
      redraw(row, '[data-gxw-find]'); const again = el.querySelector(`[data-gxw-card="${CSS.escape(row.key)}"] [data-gxw-find]`); try { again?.setSelectionRange(at, at); } catch (_) {}
    }));
    el.querySelectorAll('[data-gxw-find]').forEach((input) => input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return; event.preventDefault();
      input.closest('[data-gxw-menu]')?.querySelector('[data-gxw-member],[data-gxw-service-add]')?.click();
    }));
    el.querySelectorAll('[data-gxw-member]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button); if (!row) return;
      row.member_user_ids = [...new Set([...row.member_user_ids, button.dataset.gxwMember])];
      menu = null; report(); redraw(row, '[data-gxw-pick]');
    }));
    el.querySelectorAll('[data-gxw-newperson]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button); if (!row) return;
      menu = { row: row.key, kind: 'people', mode: 'new', draft: { name: clean(menu?.query) } };
      redraw(row, '[data-gxw-newform] [name=name]');
    }));
    el.querySelectorAll('[data-gxw-newcancel]').forEach((button) => button.addEventListener('click', () => { const row = rowOf(button); if (!row) return; menu = { row: row.key, kind: 'people', query: '' }; redraw(row, '[data-gxw-pick]'); }));
    el.querySelectorAll('[data-gxw-newform]').forEach((form) => {
      form.addEventListener('input', () => { if (menu) menu.draft = { name: form.elements.name.value, email: form.elements.email.value }; });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const row = rowOf(form); if (!row) return;
        const name = clean(form.elements.name.value), email = clean(form.elements.email.value).toLowerCase();
        const say = (text, field) => { form.querySelector('[data-gxw-newerror]').textContent = text; form.elements[field]?.focus(); };
        if (!name) return say(L('gx_wfs_member_name_required', 'Add their name.'), 'name');
        // An email is how they sign in and get their invite.
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say(L('gx_wfs_member_email_invalid', 'Add an email they can sign in with.'), 'email');
        const taken = people().find((person) => clean(person.email).toLowerCase() === email);
        if (taken) {
          if (row.member_user_ids.includes(taken.id)) return say(L('gx_wfs_member_email_on', '{name} is already on it.', { name: taken.name }), 'email');
          row.member_user_ids = [...row.member_user_ids, taken.id];
        } else {
          const person = { id: `${PENDING}${crypto.randomUUID().slice(0, 12)}`, name, email, status: 'invited', pending: true };
          newPeople.push(person); row.member_user_ids = [...row.member_user_ids, person.id];
        }
        menu = null; report(); redraw(row, '[data-gxw-pick]');
      });
    });
    el.querySelectorAll('[data-gxw-lead]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button), id = button.dataset.gxwLead; if (!row) return;
      // The lead the group already has is changed, not taken away, from here.
      row.lead_user_id = row.lead_user_id === id && !row.saved_lead ? '' : id;
      report(); redraw(row, `[data-gxw-lead="${CSS.escape(id)}"]`);
    }));
    el.querySelectorAll('[data-gxw-unmember]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button), id = button.dataset.gxwUnmember; if (!row) return;
      row.member_user_ids = row.member_user_ids.filter((entry) => entry !== id);
      if (row.lead_user_id === id) row.lead_user_id = row.saved_lead && row.member_user_ids.includes(row.saved_lead) ? row.saved_lead : '';
      // Someone new nobody kept is not added.
      if (isPending(id) && !rows.some((other) => other.member_user_ids.includes(id))) newPeople = newPeople.filter((person) => person.id !== id);
      report(); redraw(row, '[data-gxw-pick]');
    }));
    el.querySelector('[data-gxw-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxw-next]').addEventListener('click', () => {
      const unnamed = list.findIndex((row) => !clean(row.name));
      if (unnamed >= 0) { fail({ message: L('gx_wfs_name_required', 'Give each one a name.') }); el.querySelectorAll('[data-gxw-name]')[unnamed]?.focus(); return; }
      const names = list.map((row) => `${row.kind}:${clean(row.name).toLowerCase()}`);
      if (new Set(names).size !== names.length) { fail({ message: L('gx_wfs_name_unique', 'Give each one its own name.') }); return; }
      const idle = list.find((row) => services().length && !row.service_ids.length);
      if (idle) { fail({ message: L('gx_wfs_does_required', 'Pick at least one kind of work for {name}.', { name: clean(idle.name) }) }); return; }
      go(page + 1);
    });
    wireDeck();
    if (focus) {
      const target = el.querySelector(focus);
      if (target) { target.focus({ preventScroll: true }); bringIn(el.querySelector('.gxw-track'), target.closest('.gxw-card')); }
    }
  }
  function loadCatalog(){
    return catalog ? Promise.resolve(catalog) : (async () => ctx.read('company-profile', 'catalog'))().then((value) => { catalog = object(value); return catalog; }).catch(() => { catalog = { services: [] }; return catalog; });
  }

  // ── How do you pay them? ───────────────────────────────────────────────
  const unitOf = (pay) => pay?.method === 'hourly' ? L('gx_lab_per_hour', 'per hour') : pay?.method === 'per_job' ? L('gx_lab_per_job', 'per job') : String(pay?.measurement || 'roof.squares').startsWith('roof.squares') || pay?.measurement === 'roof.flat_squares' ? L('gx_lab_per_square', 'per square') : L('gx_lab_per_foot', 'per foot');
  const payText = (pay) => pay && Number(pay.rate) > 0 ? `$${Number(pay.rate).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unitOf(pay)}` : '';
  function payCard(row, list){
    const pay = row.pay, others = list.filter((other) => other !== row && !other.locked && !other.sheet && other.same !== row.key);
    const method = (id, label) => `<button type="button" role="radio" data-gxw-method="${id}" aria-checked="${pay?.method === id}">${esc(label)}</button>`;
    const same = row.same ? list.find((other) => other.key === row.same) : null;
    let body;
    if (row.locked) body = `<p class="gxw-note">${esc(L('gx_lab_locked', 'Paid by its own pay sheet'))} (${row.lines} ${esc(L('gx_lab_lines', 'lines'))}). ${esc(L('gx_lab_locked_where', 'Change it in People.'))}</p>`;
    else if (row.sheet) body = `<p class="gxw-same"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> ${esc(L('gx_wfs_sheet_sent', 'The agent is setting up their pay from the sheet you sent.'))}</p>`;
    else if (same) body = `<p class="gxw-same">${esc(L('gx_wfs_same_as', 'Paid the same as {name}', { name: clean(same.name) }))}${payText(payOf(list, row)) ? ` · ${esc(payText(payOf(list, row)))}` : ''}</p>`;
    else body = `<div class="gxw-seg" role="radiogroup" aria-label="${esc(L('gx_lab_how_paid', 'How they are paid'))}">${roofing() || pay?.method === 'per_measurement' ? method('per_measurement', L('gx_lab_piece', 'Piece rate')) : ''}${method('hourly', L('gx_lab_hourly', 'Hourly'))}${method('per_job', L('gx_lab_job', 'Per job'))}</div>
      <div class="gxw-rate"><label class="gxw-money">$<input type="number" min="0" step="0.01" inputmode="decimal" data-gxw-rate value="${Number(pay?.rate) > 0 ? esc(pay.rate) : ''}" placeholder="0.00" aria-label="${esc(L('gx_lab_rate', 'Rate'))}"></label>
      ${pay?.method === 'per_measurement' ? `<span class="gxw-unit">${esc(L('gx_wfs_per', 'per'))}</span><select class="gxw-select" data-gxw-measurement aria-label="${esc(L('gx_lab_paid_on', 'Paid on'))}">${measurements().map((entry) => `<option value="${esc(entry.id)}" ${entry.id === (pay.measurement || 'roof.squares') ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select>` : `<span class="gxw-unit">${esc(unitOf(pay))}</span>`}</div>`;
    return `<article class="gxw-card" data-gxw-card="${esc(row.key)}">${head(row)}
      ${body}
      ${!row.locked && !row.sheet && (others.length || same) ? `<label class="gxw-field"><b>${esc(L('gx_wfs_same', 'Same pay as'))}</b><select class="gxw-select" data-gxw-same><option value="">${esc(L('gx_wfs_same_none', 'Nobody: their own rates'))}</option>${list.filter((other) => other !== row && !other.locked && !other.sheet && other.same !== row.key).map((other) => `<option value="${esc(other.key)}" ${other.key === row.same ? 'selected' : ''}>${esc(other.name)}</option>`).join('')}</select></label>` : ''}
      ${ctx.paySheet && !row.locked && !row.sheet ? `<button type="button" class="gxw-sheet" data-gxw-sheet title="${esc(L('gx_lab_sheet_tip', 'Upload their pay sheet or rate card and the agent sets up their pay from it'))}"><i class="fas fa-file-arrow-up" aria-hidden="true"></i>${esc(L('gx_lab_sheet_upload', 'Upload pay sheet'))}</button>` : ''}
    </article>`;
  }
  function drawPay(){
    title(L('gx_wfs_pay_title', 'How do you pay them?'));
    const list = shown(), last = nextPage(page) === 'done';
    el.innerHTML = `<div class="gxw" data-gxw-page="pay">
      <p>${esc(L('gx_wfs_pay_lead', 'Set each one’s rate, or say they’re paid the same as another. Leave a rate empty to set it later in People.'))}</p>
      ${deck(list.map((row) => payCard(row, list)))}
      ${errorLine}
      <div class="gxw-actions">${backButton()}<span class="gxw-spacer"></span>${last ? saveButton() : nextButton()}</div>
    </div>`;
    const rowOf = (node) => rows.find((row) => row.key === node.closest('[data-gxw-card]')?.dataset.gxwCard);
    const redraw = (focus) => { const left = el.querySelector('.gxw-track')?.scrollLeft || 0; drawPay(); const track = el.querySelector('.gxw-track'); if (track) track.scrollLeft = left; if (focus) el.querySelector(focus)?.focus({ preventScroll: true }); };
    el.querySelectorAll('[data-gxw-method]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button), method = button.dataset.gxwMethod; if (!row) return;
      row.pay = { method, rate: row.pay?.method === method ? row.pay.rate : 0, ...(method === 'per_measurement' ? { measurement: row.pay?.measurement || 'roof.squares' } : {}) };
      report(); redraw(`[data-gxw-card="${CSS.escape(row.key)}"] [data-gxw-rate]`);
    }));
    el.querySelectorAll('[data-gxw-rate]').forEach((input) => input.addEventListener('input', () => {
      const row = rowOf(input); if (!row?.pay) return;
      const value = Number(input.value); row.pay = { ...row.pay, rate: Number.isFinite(value) && value >= 0 ? value : 0 };
      report();
      // Cards that copy this one say the new rate.
      list.filter((other) => other.same === row.key).forEach((other) => { const note = el.querySelector(`[data-gxw-card="${CSS.escape(other.key)}"] .gxw-same`); if (note) note.textContent = `${L('gx_wfs_same_as', 'Paid the same as {name}', { name: clean(row.name) })}${payText(payOf(list, other)) ? ` · ${payText(payOf(list, other))}` : ''}`; });
    }));
    el.querySelectorAll('[data-gxw-measurement]').forEach((select) => select.addEventListener('change', () => { const row = rowOf(select); if (row?.pay) { row.pay = { ...row.pay, measurement: select.value }; report(); } }));
    el.querySelectorAll('[data-gxw-same]').forEach((select) => select.addEventListener('change', () => { const row = rowOf(select); if (!row) return; row.same = select.value; report(); redraw(`[data-gxw-card="${CSS.escape(row.key)}"] [data-gxw-same]`); }));
    el.querySelectorAll('[data-gxw-sheet]').forEach((button) => button.addEventListener('click', () => uploadSheet(rowOf(button), button)));
    el.querySelector('[data-gxw-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxw-apply]')?.addEventListener('click', (event) => apply(event.currentTarget));
    el.querySelector('[data-gxw-next]')?.addEventListener('click', () => go(page + 1));
    wireDeck();
  }

  // ── Invite your crews to the app? ──────────────────────────────────────
  function drawInvite(){
    title(L('gx_wfs_invite_title', 'Invite your {crews_lower} to the app?', { crews_lower: crews.toLowerCase() }));
    const list = invitees();
    const crewsOf = (id) => shown().filter((row) => row.kind === GROUP && row.member_user_ids.includes(id)).map((row) => clean(row.name)).join(', ');
    el.innerHTML = `<div class="gxw" data-gxw-page="invite">
      <p>${esc(L('gx_wfs_invite_lead', 'Each one gets an email to set up their sign-in, then sees their work, schedule and more on their phone. You can invite them later from People instead.'))}</p>
      <div class="gxw-rows">${list.map((person) => `<div class="gxw-row" data-gxw-invitee="${esc(person.id)}"><span class="gxw-avatar">${esc(initials(person.name))}</span><div><strong>${esc(person.name)}</strong><small>${esc(person.email)}</small></div><em>${esc(crewsOf(person.id))}</em></div>`).join('')}</div>
      ${errorLine}
      <div class="gxw-actions">${backButton()}<span class="gxw-spacer"></span><button type="button" class="gxw-btn" data-gxw-skip>${esc(L('gx_wfs_invite_skip', 'Not now'))}</button><button type="button" class="gxw-btn primary" data-gxw-yes>${esc(L('gx_wfs_invite_yes', 'Yes, invite them'))}</button></div>
    </div>`;
    el.querySelector('[data-gxw-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxw-skip]').addEventListener('click', (event) => { invite = 'no'; report(); if (nextPage(page) === 'done') apply(event.currentTarget); else go(page + 1); });
    el.querySelector('[data-gxw-yes]').addEventListener('click', (event) => { invite = 'yes'; report(); if (nextPage(page) === 'done') apply(event.currentTarget); else go(page + 1); });
  }

  // ── What should they see? ──────────────────────────────────────────────
  // Each choice starts as the crews already have it (their App experience settings), else as the library says.
  function initialSeen(){
    const groups = shown().filter((row) => row.kind === GROUP);
    const said = (choice) => {
      for (const row of groups) {
        const option = object(choice.option), apps = object(row.apps);
        if (option.app && typeof object(object(apps[option.app]).options)[option.key] === 'boolean') return object(apps[option.app]).options[option.key];
        for (const id of array(choice.apps)) if (typeof object(apps[id]).visible === 'boolean') return apps[id].visible;
      }
      return choice.default === true;
    };
    return Object.fromEntries(crewChoices().map((choice) => [choice.id, said(choice)]));
  }
  function drawSee(){
    if (!seen) seen = initialSeen();
    title(L('gx_wfs_see_title', 'What should your {crews_lower} see?', { crews_lower: crews.toLowerCase() }));
    el.innerHTML = `<div class="gxw" data-gxw-page="see">
      <p>${esc(L('gx_wfs_see_lead', 'Choose what their app shows them. What they can do is still set by their roles, and you can change any of this later in People › App experience.'))}</p>
      <div class="gxw-sees" role="group">${crewChoices().map((choice) => `<button type="button" class="gxw-see" role="switch" data-gxw-see="${esc(choice.id)}" aria-checked="${seen[choice.id] === true}">${icon(clean(choice.icon) || 'fa-mobile-screen')}<span><strong>${esc(copy(choice.label || choice.id))}</strong>${choice.hint ? `<small>${esc(copy(choice.hint))}</small>` : ''}</span><span class="gxw-switch" aria-hidden="true"></span></button>`).join('')}</div>
      ${errorLine}
      <div class="gxw-actions">${backButton()}<span class="gxw-spacer"></span><button type="button" class="gxw-btn primary" data-gxw-apply>${esc(L('gx_wfs_see_send', 'Save and send invites'))}</button></div>
    </div>`;
    el.querySelectorAll('[data-gxw-see]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.gxwSee; seen = { ...seen, [id]: !(seen[id] === true) };
      button.setAttribute('aria-checked', String(seen[id])); report();
    }));
    el.querySelector('[data-gxw-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxw-apply]').addEventListener('click', (event) => apply(event.currentTarget));
  }

  /**
   * Their pay sheet, for the agent: the card is saved first (so a new one has an id to name), then the player picks the
   * file and hands it to the agent beside the setup, which writes their pay sheet. Their rates here are left alone.
   */
  async function uploadSheet(row, button){
    if (!row || busy || !ctx.paySheet) return;
    busy = true; button.disabled = true;
    try {
      if (!row.ref) {
        await addNewPeople([row]);
        const saved = await save([{ ...row, sheet: true }]);
        const match = array(saved.assignees).find((entry) => entry.kind === row.kind && clean(entry.name).toLowerCase() === clean(row.name).toLowerCase());
        if (match?.ref) { row.ref = match.ref; row.existing = true; row.saved_members = [...row.member_user_ids]; row.saved_lead = row.lead_user_id; }
      }
      const sent = await ctx.paySheet({ ref: row.ref, kind: row.kind, name: clean(row.name) });
      if (sent !== null && sent !== undefined && alive) { row.sheet = true; rows.forEach((other) => { if (other.same === row.key) other.same = ''; }); report(); drawPay(); }
    } catch (error) { fail(error); }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  }
  /** Adds the people added here who are not in the organization yet, and puts their ids on the cards. */
  async function addNewPeople(list){
    const wanted = [...new Set(list.flatMap((row) => row.member_user_ids).filter(isPending))];
    for (const id of wanted) {
      const person = newPeople.find((entry) => entry.id === id); if (!person) continue;
      const response = await window.PlatformAPI.publication.invoke(orgId, 'workforce.users.add', { scope: 'organization', organizationId: orgId }, { name: person.name, email: person.email }, { idempotencyKey: `operations.workforce.setup:person:${orgId}:${person.id}` });
      const user = object(object(response?.value ?? response?.result ?? response).user);
      if (!user.id) throw new Error(L('gx_wfs_member_add_failed', '{name} could not be added. Try again.', { name: person.name }));
      const added = { id: user.id, name: clean(user.name) || person.name, email: clean(user.email) || person.email, status: 'invited' };
      status.people = [...array(status.people), added];
      newPeople = newPeople.filter((entry) => entry.id !== id);
      rows.forEach((row) => { row.member_user_ids = row.member_user_ids.map((entry) => entry === id ? added.id : entry); if (row.lead_user_id === id) row.lead_user_id = added.id; });
    }
  }
  async function save(list){
    const target = { scope: 'organization', organizationId: orgId };
    const response = await window.PlatformAPI.publication.invoke(orgId, 'operations.workforce.setup.apply', target, applyInput(list, { apps: invite === 'yes' && seen ? appsFor(crewChoices(), seen) : null }), { idempotencyKey: `operations.workforce.setup:${orgId}:${crypto.randomUUID()}` });
    return object(response?.value ?? response?.result ?? response);
  }
  async function apply(button){
    if (busy) return; busy = true; button.disabled = true;
    try {
      const list = shown();
      await addNewPeople(list);
      const asked = invite === 'yes' ? invitees().map((person) => person.id) : [];
      report();
      result = await save(list);
      if (!alive) return;
      // What was just written is no longer new: a Back and a second Save change them rather than add them again.
      for (const entry of array(result.assignees)) {
        const row = shown().find((item) => item.kind === entry.kind && clean(item.name).toLowerCase() === clean(entry.name).toLowerCase());
        if (row && entry.ref) { row.ref = entry.ref; row.existing = true; row.saved_members = [...row.member_user_ids]; row.saved_lead = row.lead_user_id; }
      }
      // The invites go once everything is set up; one that fails is said on the last page, the setup is saved either way.
      invited = null;
      if (asked.length) {
        try {
          const response = await window.PlatformAPI.publication.invoke(orgId, 'workforce.users.invite', { scope: 'organization', organizationId: orgId }, { user_ids: asked }, { idempotencyKey: `operations.workforce.setup:invite:${orgId}:${crypto.randomUUID()}` });
          const value = object(response?.value ?? response?.result ?? response);
          invited = { sent: Number(value.sent || 0), failed: array(value.invites).filter((row) => !row.ok).map((row) => personName(row.user_id)) };
          status.people = array(status.people).map((person) => asked.includes(person.id) ? { ...person, invited_now: true } : person);
        } catch (error) { invited = { sent: 0, failed: asked.map(personName), error: clean(error?.message) }; }
      }
      // The Operations tab and People under the sheet read their workforce again.
      const windows = new Set([window]); try { if (window.top.location.origin === location.origin) windows.add(window.top); } catch (_) {}
      windows.forEach((win) => win.dispatchEvent(new win.CustomEvent('fm:workforce:changed', { detail: { source: 'operations.workforce.setup' } })));
      go(pages.indexOf('done'));
    } catch (error) { fail(error); }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  }

  // ── Your crews and subcontractors are set up ───────────────────────────
  function drawDone(){
    const list = shown(), both = list.some((row) => row.kind === GROUP) && list.some((row) => row.kind === COMPANY);
    title(both ? L('gx_wfs_done_title_both', 'Your {crews_lower} and {subs_lower} are set up', { crews_lower: crews.toLowerCase(), subs_lower: subs.toLowerCase() }) : L('gx_wfs_done_title', 'Who does the work is set up'));
    el.innerHTML = `<div class="gxw" data-gxw-page="done">
      <div class="gxw-done" role="status"><i class="fas fa-circle-check" aria-hidden="true"></i><p>${esc(L('gx_wfs_done_body', 'Work orders use their pay, and you can change any of it in Operations settings or People.'))}${invited?.sent ? ` ${esc(invited.sent === 1 ? L('gx_wfs_done_invited_one', 'We emailed 1 invite to the app.') : L('gx_wfs_done_invited', 'We emailed {n} invites to the app.', { n: invited.sent }))}` : ''}</p></div>
      ${invited?.failed?.length ? `<p class="gxw-error" role="alert">${esc(L('gx_wfs_done_invite_failed', 'These invites didn’t go out: {names}. Send them from People.', { names: invited.failed.join(', ') }))}</p>` : ''}
      <div class="gxw-rows">${list.map((row) => {
        const pay = payOf(list, row), same = row.same ? list.find((other) => other.key === row.same) : null;
        const kinds = tagsFor(row);
        const parts = [row.service_ids.map((id) => `${serviceLabel(id)}${kinds[id] ? ` (${kinds[id].join(', ')})` : ''}`).join(', '),
          row.kind === GROUP && row.member_user_ids.length ? L('gx_wfs_done_people', '{n} on it', { n: row.member_user_ids.length }) : '',
          row.kind === GROUP && row.lead_user_id ? L('gx_wfs_done_lead', '{name} in charge', { name: personName(row.lead_user_id) }) : '',
          row.locked ? L('gx_lab_locked', 'Paid by its own pay sheet') : row.sheet ? L('gx_wfs_done_sheet', 'Pay from their sheet') : same ? L('gx_wfs_same_as', 'Paid the same as {name}', { name: clean(same.name) }) : payText(pay) || L('gx_wfs_done_no_pay', 'Pay not set yet')].filter(Boolean);
        return `<div class="gxw-row" data-gxw-done="${esc(row.key)}">${icon(row.kind === GROUP ? 'fa-users' : 'fa-handshake')}<div><strong>${esc(row.name)}</strong><small>${esc(parts.join(' · '))}</small></div></div>`;
      }).join('')}</div>
      ${errorLine}
      <div class="gxw-actions"><span class="gxw-spacer"></span><button type="button" class="gxw-btn primary" data-gxw-finish>${esc(L('gx_ui_done', 'Done'))}</button></div>
    </div>`;
    el.querySelector('[data-gxw-finish]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (busy) return; busy = true; button.disabled = true;
      try { await ctx.complete?.(); } catch (error) { fail(error); } finally { busy = false; if (button.isConnected) button.disabled = false; }
    });
  }

  function draw(){
    if (!alive) return;
    whoStep?.destroy?.(); whoStep = null;
    const name = pages[page];
    // The cards need room: their pages take the large sheet (about the project window's size), the others its usual size.
    ctx.setWide?.(name === 'work' || name === 'pay');
    if (name === 'who') drawWho();
    else if (name === 'count') drawCount();
    else if (name === 'work') drawWork();
    else if (name === 'pay') drawPay();
    else if (name === 'invite') drawInvite();
    else if (name === 'see') drawSee();
    else drawDone();
  }
  // A dropdown closes when someone clicks outside it.
  const outside = (event) => {
    if (!menu || pages[page] !== 'work' || !event.target.isConnected || event.target.closest('[data-gxw-menu],[data-gxw-pick],[data-gxw-other]')) return;
    menu = null; drawWork('');
  };
  el.addEventListener('click', outside);

  el.innerHTML = '<div class="gxw"><div class="gxw-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
  // Read when the step shows, not when the setup opened: the setup steps before it may have just answered the profile.
  Promise.all([ctx.read('workforce-setup', 'status'), (async () => ctx.read('company-profile', 'catalog'))().catch(() => null)]).then(([value, read]) => {
    if (!alive) return;
    status = object(value); profile = object(status.profile); catalog = read ? object(read) : null;
    workforce = savedWorkforce = clean(profile.workforce);
    const known = new Set(services().map((entry) => entry.id));
    rows = array(status.assignees).filter((entry) => inWorkforce(options, entry)).map((entry) => {
      const simple = entry.pay?.simple || null;
      // A service saved before that the profile does not list (added under Other) is still shown, from the catalog.
      const saved = array(entry.service_ids).filter((id) => known.has(id) || catalogService(id));
      for (const id of saved) if (!known.has(id) && !extraServices.some((other) => other.id === id)) extraServices.push({ id, label: copy(catalogService(id).label) });
      return { key: `${entry.kind}:${clean(entry.ref?.id)}`, ref: entry.ref, kind: entry.kind, existing: true, name: clean(entry.name),
        // Nothing said yet about what it does: everything the company does, until the person says otherwise.
        service_ids: saved.length ? saved : [...known], service_tags: object(entry.service_tags), member_user_ids: array(entry.member_user_ids), saved_members: array(entry.member_user_ids),
        lead_user_id: clean(entry.lead_user_id), saved_lead: clean(entry.lead_user_id), apps: object(entry.apps),
        locked: !!entry.pay && !simple, lines: Number(entry.pay?.lines || 0), pay: simple ? { ...simple } : defaultPay(options, profile, entry.kind), same: '' };
    });
    for (const kind of [GROUP, COMPANY]) counts[kind] = Math.max(1, existingOf(kind).length);
    if (workforce) fitRows();
    // Who does the work was answered (the setup step before this one, or another setup): start after it; Back still
    // reaches it to change the answer.
    if (workforce) page = pages.indexOf(workforce === 'just_me' ? 'work' : 'count');
    report(); draw(); ctx.syncBack?.();
  }).catch((error) => { if (alive) { el.innerHTML = `<div class="gxw">${errorLine}</div>`; fail(error); } });
  return {
    valid: () => true,
    // Escape closes an open dropdown first.
    escape: () => { if (busy) return true; if (menu && pages[page] === 'work') { menu = null; drawWork(''); return true; } return false; },
    // The phone's back walks these pages first; once everything is written there is nothing to go back to.
    backDepth: () => pages[page] === 'done' ? 0 : pages.slice(0, page).filter((name) => !skip(name)).length,
    back(){ if (pages[page] === 'done' || page === 0) return false; go(page - 1); return true; },
    destroy(){ alive = false; whoStep?.destroy?.(); el.removeEventListener('click', outside); ctx.setWide?.(false); }
  };
}
export default mount;
