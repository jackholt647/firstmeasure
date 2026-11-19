// The document setup's steps (guided experience `documents.setup`, FM-582, docs/architecture/guided-experiences.md,
// "Document setup"). It plays the first time someone who manages company settings presses New document: which kind
// of document they want to make, then for a proposal (after the company type, the kinds of work and who sells, each
// asked only while unanswered) how they present it, whether the customer may change it, how much detail it carries,
// whether a description and photos of the work go with it (GP-50), their prices (optional), and for every kind one of three styles,
// previewed with what their answers make. Then the template's wording, to read and change beside it (`copy`, FM-614;
// Advanced opens the template itself in the template editor), and for a proposal started in a project the first
// proposal made from it, through the Docs app's own workflow (`first`). Each step is this module with its own `part`;
// the answers are the setup's selections and its finish (documents.setup.apply) makes the kind's template. It reads
// through the publication layer (document-setup.price_sheet, .previews, .copy); only Advanced and the first proposal
// save the template before the finish, because they need it.
// A company that does insurance work is asked first which kinds of proposals it makes (GP-55, `proposal_kinds`): retail,
// insurance contingency agreements, or both. Insurance only goes straight to the style and the agreement's wording;
// both goes through the retail questions, then has a second wording page for the agreement (`copy_insurance`), and the
// first proposal starts with a choice of which to make.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
// What a heading is called in its field's label (GP-18): its own words, kept short. A phrase is cut at its first
// separator ("Roof replacement · Itemized proposal" is "Roof replacement"), and one of more than three words is called
// by its first word that names something ("What your selected option includes" is "Option").
const HEADING_FILLER = new Set('a an and are at be by for here how in includes include included including is it its my of on or our paid selected still that the their these this those to was we were what when where which who why will with you your'.split(' '));
function headingName(text){
  const whole = clean(text).replace(/\s+/g, ' ');
  let words = (whole.split(/\s[·•|—–-]\s|[,:;(]/)[0].trim() || whole).split(' ');
  if (words.length > 3) {
    const named = words.find((word) => !HEADING_FILLER.has(word.toLowerCase().replace(/[^a-z]/g, '')));
    if (named) words = [named];
  }
  const name = words.join(' ');
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

const css = `
.gxd{display:flex;flex-direction:column;gap:14px;min-width:0;padding:2px 0 8px;color:#101828}
.gxd p{margin:0;color:#475467;line-height:1.5;font-size:13px}
.gxd-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.gxd-tile{position:relative;display:flex;align-items:flex-start;gap:12px;min-height:76px;padding:14px 42px 14px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .2s,transform .15s}
.gxd-tile:hover{border-color:#c4c9d2;transform:translateY(-1px)}
.gxd-tile:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxd-tile>span:not(.gxd-icon):not(.gxd-tick):not(.gxs-choice-text){display:flex;flex-direction:column;gap:3px;min-width:0}
.gxd-tile strong{font-size:14px;font-weight:700;line-height:1.25}
.gxd-tile small{font-size:12px;color:#667085;line-height:1.4}
.gxd-tile[aria-checked=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxd-icon{flex:none;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025);font-size:16px}
.gxd-tick{position:absolute;top:10px;right:10px;width:22px;height:22px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;transition:background .15s,border-color .15s}
.gxd-tick svg{width:12px;height:12px;stroke:#fff;fill:none;stroke-width:3;opacity:0;transition:opacity .15s}
[aria-checked=true]>.gxd-tick{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
[aria-checked=true]>.gxd-tick svg{opacity:1}
.gxd-group{display:flex;flex-direction:column;gap:10px}
.gxd-tile.gxd-feature{align-items:center;gap:16px;min-height:112px;padding:20px 48px 20px 20px;border-width:1.5px}
.gxd-feature .gxd-icon{width:56px;height:56px;border-radius:15px;font-size:24px}
.gxd-feature strong{font-size:19px}
.gxd-feature small{font-size:13.5px}
.gxd-feature .gxd-tick{top:14px;right:14px;width:24px;height:24px}
.gxd-badge{align-self:flex-start;display:inline-flex;align-items:center;height:22px;padding:0 9px;margin-bottom:3px;border-radius:999px;background:var(--primary,#d93025);color:#fff;font-size:11px;font-style:normal;font-weight:700;letter-spacing:.02em}
.gxd-others{margin:6px 0 0!important;font-size:12px!important;font-weight:650;color:#667085!important;text-transform:uppercase;letter-spacing:.04em}
.gxd-grid.gxd-small{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.gxd-small .gxd-tile{min-height:64px;padding:11px 36px 11px 12px;gap:10px}
.gxd-small .gxd-icon{width:32px;height:32px;border-radius:9px;font-size:14px}
.gxd-small .gxd-tile strong{font-size:13.5px}
.gxd-small .gxd-tile small{font-size:11.5px}
.gxd-small .gxd-tick{width:20px;height:20px;top:9px;right:9px}
/* A question with two answers lays them out as every setup's choices do (GP-46: guided-setup.js, .gxs-choices): two
   near-square tiles on a desktop (FM-615), two stacked rectangles on a phone. */
/* The price step (FM-610): two columns of lines, each with its picture, price and switch, in the wide sheet. */
.gxd-lead{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.gxd-lead p{flex:1 1 320px}
.gxd-upload{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px;border:1.5px solid var(--primary,#d93025);border-radius:11px;background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary,#d93025);font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;transition:background .15s}
.gxd-upload:hover{background:rgba(var(--primary-rgb,217,48,37),.12)}
.gxd-upload:focus-visible,.gxd-add:focus-visible,.gxd-switch:focus-visible,.gxd-option:focus-visible,.gxd-btn:focus-visible,.gxd-link:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxd-banner{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;border-radius:12px;background:rgba(var(--primary-rgb,217,48,37),.07);color:#344054;font-size:13px;line-height:1.45}
.gxd-banner i{color:var(--primary,#d93025);margin-top:2px}
.gxd-lines{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.gxd-line{display:flex;align-items:center;gap:12px;min-width:0;padding:10px 12px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;transition:background .15s,border-color .15s}
.gxd-line .gxd-icon{width:36px;height:36px;border-radius:10px;font-size:15px;transition:opacity .15s}
.gxd-line-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.gxd-line-main strong{font-size:13.5px;font-weight:650;color:#101828;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxd-line-main small{display:flex;align-items:center;gap:6px;min-height:15px;font-size:11.5px;color:#667085;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.gxd-tag{flex:none;padding:1px 7px;border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary,#d93025);font-size:10.5px;font-style:normal;font-weight:700}
.gxd-line[data-on=false]{background:#f9fafb;border-style:dashed}
.gxd-line[data-on=false] .gxd-icon,.gxd-line[data-on=false] .gxd-line-main,.gxd-line[data-on=false] .gxd-money{opacity:.45}
.gxd-money{display:flex;align-items:center;gap:6px;flex:none;color:#667085;font-size:12px}
.gxd-money span:first-child{color:#344054;font-size:13px}
.gxd-money input{width:84px;height:34px;padding:0 10px;border:1px solid #d0d5dd;border-radius:9px;font:inherit;font-size:14px;text-align:right;color:#101828;background:#fff}
.gxd-money input:focus,.gxd-field input:focus,.gxd-field select:focus,.gxd-term input:focus,.gxd-term select:focus{outline:none;border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxd-line .gxd-money>span:last-child{min-width:58px;white-space:nowrap}
.gxd-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:0;border-radius:999px;background:#d0d5dd;cursor:pointer;transition:background .15s}
.gxd-switch span{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.2);transition:transform .15s}
.gxd-switch[aria-checked=true]{background:var(--primary,#d93025)}
.gxd-switch[aria-checked=true] span{transform:translateX(16px)}
.gxd-add{display:flex;align-items:center;justify-content:center;gap:8px;min-height:58px;border:1.5px dashed #c4c9d2;border-radius:13px;background:#fff;color:var(--primary,#d93025);font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;transition:border-color .15s,background .15s}
.gxd-add:hover{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.04)}
.gxd-editor{grid-column:1/-1;display:flex;flex-direction:column;gap:12px;padding:14px;border:1.5px solid var(--primary,#d93025);border-radius:13px;background:#fff;box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.08)}
.gxd-editor-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.gxd-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.gxd-field.gxd-name{flex:1 1 240px;position:relative}
.gxd-field label,.gxd-label{font-size:12px;font-weight:650;color:#344054}
.gxd-field input:not([type=checkbox]),.gxd-field select,.gxd-term input,.gxd-term select{height:36px;padding:0 10px;border:1px solid #d0d5dd;border-radius:9px;font:inherit;font-size:13.5px;color:#101828;background:#fff;min-width:0}
.gxd-field .gxd-money input{width:96px}
.gxd-suggest{display:flex;flex-direction:column;margin-top:4px;border:1px solid #e4e7ec;border-radius:11px;overflow:clip;background:#fff}
.gxd-suggest:empty{display:none}
.gxd-option{display:flex;align-items:center;gap:10px;padding:8px 12px;border:0;border-top:1px solid #f2f4f7;background:#fff;font:inherit;text-align:left;cursor:pointer;color:#101828}
.gxd-option:first-child{border-top:0}
.gxd-option>i{width:18px;text-align:center;color:var(--primary,#d93025)}
.gxd-option span{display:flex;flex-direction:column;min-width:0}
.gxd-option strong{font-size:13px;font-weight:650}
.gxd-option small{font-size:11.5px;color:#667085}
.gxd-option:hover,.gxd-option[aria-selected=true]{background:rgba(var(--primary-rgb,217,48,37),.06)}
.gxd-option-new strong{color:var(--primary,#d93025)}
.gxd-terms{display:flex;flex-direction:column;gap:8px}
.gxd-term{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gxd-term .gxd-factor{width:64px;text-align:right}
.gxd-term select{flex:1 1 220px;max-width:340px}
.gxd-plus,.gxd-times{color:#667085;font-weight:700}
.gxd-plus{width:14px;text-align:center}
.gxd-edit{font-size:12px;color:#667085;background:transparent}
.gxd-edit:hover{background:#f2f4f7;color:#344054}
.gxd-icon-btn{flex:none;width:30px;height:30px;border:0;border-radius:8px;background:#f2f4f7;color:#475467;font-size:18px;line-height:1;cursor:pointer}
.gxd-term-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.gxd-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:#344054;cursor:pointer}
.gxd-hint{font-size:11.5px;color:#667085}
.gxd-editor-actions{display:flex;justify-content:flex-end;gap:10px;align-items:center}
.gxd-link{border:0;background:none;padding:4px 2px;color:var(--primary,#d93025);font:inherit;font-size:13px;font-weight:650;cursor:pointer}
.gxd-btn{height:36px;padding:0 16px;border:0;border-radius:10px;background:var(--primary,#d93025);color:#fff;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer}
.gxd.gxd-uploads{flex:1 1 auto;min-height:0;padding-bottom:0}
.gxd-files{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin:0;padding:0;list-style:none;flex:0 1 auto;min-height:0;overflow-y:auto}
.gxd-files:empty{display:none}
.gxd-file{display:flex;align-items:center;gap:12px;min-width:0;padding:10px 12px;border:1px solid #e4e7ec;border-radius:13px;background:#fff}
.gxd-file .gxd-icon{width:36px;height:36px;border-radius:10px;font-size:15px}
.gxd-file .gxd-icon .gxs-spin{width:16px;height:16px}
.gxd-file[data-state=failed]{border-color:#fecdca;background:#fffbfa}
.gxd-file[data-state=failed] .gxd-icon{background:#fee4e2;color:#b42318}
.gxd-file .gxd-line-main small{display:block}
.gxd-file[data-state=failed] small{color:#b42318;white-space:normal}
.gxd-file-ok{flex:none;color:#12b76a;font-size:16px}
.gxd-drop{flex:none;flex-direction:column;gap:4px;min-height:96px;padding:14px;text-align:center}
.gxd-drop>i{font-size:20px}
.gxd-drop span{display:flex;flex-direction:column;gap:2px}
.gxd-drop small{font-size:12px;font-weight:500;color:#667085}
.gxd-drop.gxd-dragging{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06)}
.gxd-banner.gxd-more{margin:0}
.gxd-uploads-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:auto;padding:12px 0 2px;border-top:1px solid #f2f4f7;background:#fff}
.gxs-choices .gxd-badge{align-self:auto}
.gxd-note{font-size:12px!important;color:#667085!important}
/* GP-94: the proposal kinds note sits centred under its two tiles. */
.gxd-note.gxd-note-center{text-align:center}
.gxd.gxd-fill{flex:1 1 auto;gap:10px;padding-bottom:0}
/* The styles as a looping carousel (Jack): the one in the middle large, its pages scrolling; the others peek in smaller.
   The cards keep a margin above and below for their shadows (FM-608: the top looked cut off), and dragging with a mouse
   or a finger turns it (touch-action leaves up and down to the document's own scroll). */
.gxd-stage{position:relative;flex:1 1 auto;min-height:360px;overflow-x:clip;overflow-y:visible;outline:none;touch-action:pan-y;-webkit-user-select:none;user-select:none}
.gxd-stage *{touch-action:pan-y}
.gxd-stage.gxd-dragging,.gxd-stage.gxd-dragging *{cursor:grabbing!important}
.gxd-stage.gxd-dragging .gxd-card{transition:none}
.gxd-card{position:absolute;top:0;left:50%;display:flex;flex-direction:column;border-radius:10px;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.1),0 10px 28px rgba(16,24,40,.12);transform-origin:50% 50%;transition:transform .45s cubic-bezier(.22,1,.36,1),opacity .35s,box-shadow .3s;cursor:pointer;overflow:clip}
.gxd-card.gxd-jump{transition:none}
.gxd-card.gxd-ghost{pointer-events:none}
.gxd-card[data-role=center]{cursor:grab;box-shadow:0 2px 8px rgba(16,24,40,.12),0 22px 50px rgba(16,24,40,.2)}
.gxd-card[data-role=side]{opacity:.55}
.gxd-card[data-role=side]:hover{opacity:.8}
/* Between the pages of a document, a grey gutter: on white they ran together. */
.gxd-doc{flex:1 1 auto;min-height:0;overflow:clip;background:#e4e7ec}
.gxd-card[data-role=center] .gxd-doc{overflow-y:auto;scrollbar-width:thin}
.gxd-doc>div{position:relative}
.gxd-doc .fmdoc-page{margin-bottom:44px;box-shadow:none}
.gxd-doc .fmdoc-page:last-child{margin-bottom:0}
.gxd-expand{position:absolute;top:12px;right:20px;z-index:2;width:38px;height:38px;border:0;border-radius:10px;background:rgba(16,24,40,.66);color:#fff;font-size:15px;cursor:pointer;display:grid;place-items:center;opacity:0;transition:opacity .2s,background .15s;box-shadow:0 4px 12px rgba(16,24,40,.22)}
.gxd-card[data-role=center]:hover .gxd-expand,.gxd-expand:focus-visible{opacity:1}
.gxd-card[data-role=side] .gxd-expand{display:none}
.gxd-expand:hover{background:rgba(16,24,40,.86)}
.gxd-expand:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
@media(hover:none){.gxd-card[data-role=center] .gxd-expand{opacity:1}}
.gxd-arrow{position:absolute;top:50%;z-index:12;width:44px;height:44px;margin-top:-22px;border:0;border-radius:50%;background:rgba(16,24,40,.72);color:#fff;font-size:20px;line-height:1;cursor:pointer;box-shadow:0 4px 14px rgba(16,24,40,.25)}
.gxd-arrow:hover{background:rgba(16,24,40,.88)}
.gxd-arrow:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxd-arrow[data-go="-1"]{left:8px}
.gxd-arrow[data-go="1"]{right:8px}
/* The name and the dots sit on the line of the sheet's Back and Done, which float over this step (FM-608): they keep
   clear of them at the sides. */
.gxd-under{display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 230px;flex:none}
.gxd-caption{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;column-gap:12px;row-gap:2px;min-height:26px;text-align:center}
.gxd-caption strong{display:block;font-size:17px;color:#101828}
.gxd-caption small{display:block;font-size:13px;color:#667085}
.gxd-dots{display:flex;gap:6px;justify-content:center}
.gxd-dots button{width:8px;height:8px;padding:0;border:0;border-radius:50%;background:#d0d5dd;cursor:pointer}
.gxd-dots button[aria-current=true]{width:22px;border-radius:999px;background:var(--primary,#d93025)}
/* One style full screen, its pages scrolling, with the others a press of an arrow away. */
.gxd-view{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;background:rgba(16,24,40,.94);color:#fff;animation:gxdViewIn .22s ease-out both}
.gxd-view-bar{display:flex;align-items:center;gap:14px;padding:12px 16px 12px 22px;flex:none}
.gxd-view-bar>div{flex:1;min-width:0;display:flex;align-items:baseline;flex-wrap:wrap;column-gap:12px}
.gxd-view-bar strong{font-size:17px}
.gxd-view-bar small{font-size:13px;color:rgba(255,255,255,.72)}
.gxd-view-close{width:40px;height:40px;border:0;border-radius:10px;background:rgba(255,255,255,.12);color:#fff;font-size:26px;line-height:1;cursor:pointer}
.gxd-view-close:hover{background:rgba(255,255,255,.22)}
.gxd-view-close:focus-visible,.gxd-view .gxd-arrow:focus-visible{outline:2px solid #fff;outline-offset:2px}
.gxd-view-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:8px 0 40px}
.gxd-view-doc{margin:0 auto;border-radius:6px;overflow:clip}
.gxd-view-doc>div{position:relative}
.gxd-view-doc .fmdoc-page{margin-bottom:28px}
.gxd-view-doc .fmdoc-page:last-child{margin-bottom:0}
.gxd-view .gxd-arrow{position:fixed;box-shadow:0 0 0 1px rgba(255,255,255,.3),0 4px 14px rgba(0,0,0,.3)}
.gxd-view .gxd-arrow[data-view-go="-1"]{left:16px}
.gxd-view .gxd-arrow[data-view-go="1"]{right:16px}
@keyframes gxdViewIn{from{opacity:0}to{opacity:1}}
/* The wording beside the document (FM-614): the fields on the left, the document on the right, its pages scrolling. */
/* The step holds still and each column scrolls on its own: a field taking focus never scrolls the step's title away. */
.gxd.gxd-fill.gxd-copy-step,.gxd.gxd-fill.gxd-first{min-height:0}
.gxd-copy{display:grid;grid-template-columns:minmax(128px,176px) minmax(280px,1fr) clamp(320px,38%,520px);grid-template-rows:minmax(0,1fr);gap:22px;flex:1 1 auto;min-height:0}
/* The parts of the wording down the left (GP-97): a thin contents list; each part's add-below and delete show on hover
   or when it is the part being read, and the last deletion can be undone. */
.gxd-copy-nav{display:flex;flex-direction:column;align-items:stretch;min-height:0;min-width:0;overflow-y:auto;padding:2px 12px 12px 0;margin-right:-10px;border-right:1px solid #eaecf0;animation:gxdSlideIn .45s cubic-bezier(.22,1,.36,1) both}
.gxd-copy-nav:empty{border-right-color:transparent}
.gxd-copy-nav ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.gxd-copy-nav-item{position:relative;display:flex;align-items:center;min-width:0;border-radius:7px;transition:background .15s}
.gxd-copy-nav-item:hover{background:#f9fafb}
.gxd-copy-nav-item.gxd-on{background:#f2f4f7}
.gxd-copy-nav-item.gxd-on::before{content:'';position:absolute;left:0;top:7px;bottom:7px;width:2px;border-radius:2px;background:var(--primary,#d93025)}
.gxd-copy-nav-go{flex:1 1 auto;min-width:0;border:0;background:none;padding:6px 4px 6px 10px;font:inherit;font-size:12.5px;line-height:1.35;color:#475467;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gxd-copy-nav-item.gxd-on .gxd-copy-nav-go{color:#101828;font-weight:600}
.gxd-copy-nav-tools{flex:none;display:flex;gap:1px;padding-right:3px;visibility:hidden;opacity:0;transition:opacity .15s}
.gxd-copy-nav-item:hover .gxd-copy-nav-tools,.gxd-copy-nav-item:focus-within .gxd-copy-nav-tools,.gxd-copy-nav-item.gxd-on .gxd-copy-nav-tools{visibility:visible;opacity:1}
.gxd-copy-nav-tools button{width:22px;height:22px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:none;color:#98a2b3;font-size:10.5px;cursor:pointer}
.gxd-copy-nav-tools button:hover{background:#e4e7ec;color:#101828}
.gxd-copy-nav-tools [data-sec-delete]:hover{background:#fef3f2;color:#b42318}
.gxd-copy-add,.gxd-copy-undo{align-self:flex-start;display:inline-flex;align-items:center;gap:7px;margin-top:6px;padding:6px 10px;border:0;border-radius:7px;background:none;font:inherit;font-size:12.5px;font-weight:600;color:#667085;cursor:pointer;white-space:nowrap}
.gxd-copy-add i,.gxd-copy-undo i{font-size:10.5px}
.gxd-copy-add:hover{background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary,#d93025)}
.gxd-copy-undo{margin-top:0;font-weight:500;color:#475467}
.gxd-copy-undo:hover{background:#f2f4f7;color:#101828}
.gxd-copy-nav button:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:-2px}
.gxd-copy-sec{display:flex;flex-direction:column;gap:12px}
.gxd-copy-sec>*{flex-shrink:0}
.gxd-copy-new{animation:gxdSecIn .3s ease both}
@keyframes gxdSecIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.gxd-copy-fields{position:relative;display:flex;flex-direction:column;min-height:0;min-width:0}
.gxd-copy-edit{flex:1 1 auto;display:flex;flex-direction:column;gap:12px;min-height:0;overflow-y:auto;padding:2px 6px 18px 2px;animation:gxdSlideIn .45s cubic-bezier(.22,1,.36,1) both}
/* Each field keeps its own height when they are more than the column holds (GP-55: a textarea, overflow hidden, shrank to a sliver). */
.gxd-copy-edit>*{flex-shrink:0}
/* Wording below the column's edge (GP-29): the edge fades and a pill says how many fields are left; tapping it scrolls on. */
.gxd-copy-fields.gxd-more .gxd-copy-edit{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 56px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 56px),transparent)}
.gxd-copy-more{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 13px;border:0;border-radius:999px;background:#101828;color:#fff;font:inherit;font-size:12.5px;font-weight:650;white-space:nowrap;cursor:pointer;box-shadow:0 6px 16px rgba(16,24,40,.22);touch-action:none}
.gxd-copy-more[hidden]{display:none}
.gxd-copy-more:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
@keyframes gxdSlideIn{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:none}}
.gxd-copy-edit label{display:flex;flex-direction:column;gap:5px;font-size:11.5px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#667085}
.gxd-copy-edit input,.gxd-copy-edit textarea{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:8px 10px;font:inherit;font-size:13.5px;font-weight:400;letter-spacing:0;text-transform:none;color:#101828;line-height:1.5;resize:none;overflow:hidden;transition:border-color .15s,box-shadow .15s}
.gxd-copy-edit input:focus,.gxd-copy-edit textarea:focus{outline:none;border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
.gxd-copy-edit .gxd-copy-title{font-size:16px;font-weight:700}
/* A heading's field (GP-18): a little room above it, where a part of the document starts, and its words bold as they print. */
.gxd-copy-edit .gxd-copy-heading{margin-top:6px}
.gxd-copy-heading>input{font-weight:700}
.gxd-copy-edited{font-size:12px;color:#067647!important}
.gxd-copy-view{position:relative;min-height:0;border-radius:12px;background:#eef0f3;overflow:hidden}
.gxd-copy-view .gxd-doc{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;padding:14px;box-sizing:border-box}
.gxd-copy-view .gxd-doc>div{margin:0 auto}
.gxd-copy-view [data-node-id].gxd-copy-mark{outline:2px solid var(--primary,#d93025);outline-offset:3px;border-radius:2px}
/* Advanced: a link beside the step's title, only when the organization has the template editor (GP-13). */
.gxs-titlebar:has(.gxd-studio-link) h2{flex:0 1 auto}
.gxd-studio-link{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:0;border-radius:7px;background:none;font:inherit;font-size:13px;font-weight:600;color:#475467;cursor:pointer}
.gxd-studio-link:hover{background:#f2f4f7;color:#101828}
.gxd-studio-link:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
.gxd-studio-link:disabled{opacity:.6;cursor:default}
.gxd-advanced{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;font:inherit;font-size:13px;font-weight:650;color:#344054;cursor:pointer}
.gxd-advanced:hover{background:#f9fafb}
.gxd-advanced:disabled{opacity:.6;cursor:default}
/* The template editor over the sheet (Advanced). */
.gxd-studio{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;background:#fff;border-radius:inherit;overflow:hidden;animation:gxdViewIn .2s ease both}
.gxd-studio>.gxd-studio-app{flex:1 1 auto;min-height:0;position:relative;overflow:auto}
.gxd-studio .gxd-busy{position:absolute;inset:0}
/* The first proposal: the Docs app's own workflow for the new template, without its top bar (the sheet is its frame). */
.gxd-first{display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0}
.gxd-first-lead{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;background:#ecfdf3;color:#05603a!important;font-size:13px!important}
.gxd-first-lead i{font-size:15px}
.gxd-first-app{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;border-radius:10px}
.gxd-first-app .fmdx-editor-top,.gxd-first-app .fmdx-doc-card-row{display:none!important}
.gxd-first .gxd-busy{flex:1 1 auto;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;min-height:100%;color:#475467;font-size:13px}
/* The wide steps (style, prices, wording, first proposal) take the project window's size (GP-23): on the page the
   window manager's modal (min(1720, 96%) x min(1180, 92%), centred), in a project window the whole window. A phone keeps
   the player's full-screen sheet. */
@media (min-width:761px){
  .gxs.gxs-wide[data-gx-setup="documents.setup"] .gxs-sheet{width:min(1720px,96vw);height:min(1180px,calc(var(--gx-vh,100vh) * .92));border-radius:12px}
  .project-window-embedded .gxs.gxs-wide[data-gx-setup="documents.setup"] .gxs-sheet{width:100vw;height:var(--gx-vh,100vh);border-radius:0;box-shadow:none}
}
.gxd-ghost-doc{position:fixed;margin:0;z-index:2147483600;transform-origin:0 0;overflow:hidden!important;pointer-events:none;background:#eef0f3;border-radius:12px;box-shadow:0 18px 50px rgba(16,24,40,.22);transition:transform .6s cubic-bezier(.22,1,.36,1),opacity .3s}
@media (max-width:760px){
  /* A phone: the fields over the document, each scrolling on its own. The fields take what the document leaves (it keeps
     at least 300px, or 45% on a short screen or with the keyboard up); unbounded, they ran on under the document and
     could not be scrolled to (GP-29). */
  .gxd-copy{grid-template-columns:1fr;grid-template-rows:auto minmax(0,auto) minmax(min(300px,45%),1fr);gap:14px}
  /* The parts: one line of chips over the fields, scrolling sideways; delete shows on the part being read. */
  .gxd-copy-nav{flex-direction:row;align-items:center;gap:6px;overflow-x:auto;overflow-y:hidden;padding:1px 0 3px;margin:0;border-right:0;scrollbar-width:none}
  .gxd-copy-nav::-webkit-scrollbar{display:none}
  .gxd-copy-nav ol{flex-direction:row;gap:6px}
  .gxd-copy-nav-item{flex:none;max-width:200px;border:1px solid #e4e7ec;border-radius:999px;background:#fff}
  .gxd-copy-nav-item.gxd-on{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06)}
  .gxd-copy-nav-item.gxd-on::before,.gxd-copy-nav-tools [data-sec-add-after]{display:none}
  .gxd-copy-nav-item:not(.gxd-on) .gxd-copy-nav-tools{display:none}
  .gxd-copy-nav-go{padding:5px 6px 5px 11px}
  .gxd-copy-add,.gxd-copy-undo{flex:none;margin:0;padding:5px 10px}
}
.gxd-busy{display:grid;place-items:center;min-height:180px}
.gxd-error{color:#b42318!important}
.gxd-error:empty{display:none}
@media(max-width:640px){.gxd-grid,.gxd-grid.gxd-small,.gxd-lines{grid-template-columns:1fr}.gxd-tile.gxd-feature{min-height:96px;padding:16px 44px 16px 16px}.gxd-feature .gxd-icon{width:46px;height:46px;font-size:20px}.gxd-feature strong{font-size:17px}}
/* A phone: a line's name wraps, beside a narrower price. */
@media(max-width:640px){.gxd-line{gap:9px;padding:9px 10px}.gxd-line .gxd-icon{width:30px;height:30px;font-size:13px}.gxd-line-main strong{white-space:normal;line-height:1.25}.gxd-line-main small{display:none}.gxd-line .gxd-money input{width:68px;padding:0 8px}.gxd-line .gxd-money>span:last-child{min-width:0;width:44px;font-size:11px;white-space:normal;line-height:1.2}}
@media(max-width:640px){.gxd-stage>.gxd-arrow{display:none}.gxd-view .gxd-arrow{top:auto;bottom:16px}}
/* On a phone the sheet's Back and Done have the bottom line to themselves: the name and dots sit above them. */
@media(max-width:760px){.gxd-under{padding:0 0 58px}}
@media(prefers-reduced-motion:reduce){.gxd *{transition:none!important}}
`;
function installStyle(){
  if (document.getElementById('gxd-css')) return;
  const style = document.createElement('style'); style.id = 'gxd-css'; style.textContent = css; document.head.append(style);
}
const tick = '<span class="gxd-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>';
const choiceTick = '<span class="gxd-tick gxs-choice-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>';
const scripts = new Map();
function loadScript(path){
  if (!scripts.has(path)) scripts.set(path, new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = path; script.onload = resolve;
    script.onerror = () => { script.remove(); scripts.delete(path); reject(new Error('The preview could not be loaded.')); };
    document.head.append(script);
  }));
  return scripts.get(path);
}
async function renderer(){
  if (!window.FMDocModel) await loadScript('/libraries/doc-model/firstmate-doc-model.js');
  // Signatures, payment and other widgets draw as they do on the document, not as placeholders.
  if (!window.FMDocWidgets) await loadScript('/libraries/doc-widgets/firstmate-doc-widgets.js').catch(() => null);
  if (!window.FMDocRenderer) await loadScript('/libraries/doc-renderer/firstmate-doc-renderer.js');
  return window.FMDocRenderer;
}

/**
 * The person's wording over a definition's copy, as the finish saves it (documents/setup.ts applyCopy, which this
 * mirrors): parts added (`sections.added`, GP-97) go in after the part named, a heading and a paragraph made like those
 * already there, and parts removed are taken out; then each text node named gets the text given, a paragraph per
 * blank-line separated part, in its first block's style and its first run's font. `structure` is the parts as the server
 * read them (document-setup.copy `sections`). The copy step lays it over its preview as they type.
 */
function applyCopy(definition, copy, changes = {}, structure = []){
  const removed = array(changes.removed).map(clean), added = array(changes.added).map(object), parts = array(structure);
  if (!Object.keys(copy).length && !removed.length && !added.length) return definition;
  const where = new Map();
  const index = (children) => { for (const node of array(children)) { if (clean(node?.id)) where.set(clean(node.id), { node, siblings: children }); index(node?.children); } };
  for (const page of array(definition?.pages)) index(page?.children);
  const allowed = new Set(parts.flatMap((part) => [...(part.heading ? [part.heading] : []), ...array(part.texts)]));
  const words = (id) => String(copy[id] ?? '').trim();
  const like = (anchor, pick) => {
    const at = anchor ? parts.indexOf(anchor) : parts.length;
    const near = [...parts.slice(0, at + 1).reverse(), ...parts.slice(at + 1)];
    const id = [...near.filter((part) => !part.title && part.heading && array(part.texts).length), ...near.filter((part) => !part.title), ...near].map(pick).find(Boolean);
    return id ? where.get(id)?.node : undefined;
  };
  const make = (from, id, style) => {
    const { children: _children, bind: _bind, ...rest } = JSON.parse(JSON.stringify(from));
    const { style_ref: styleRef, ...block } = object(array(object(rest.props).blocks)[0]);
    const { text: _text, bind: _runBind, ...run } = object(array(block.runs)[0]);
    const ref = style === undefined ? clean(styleRef) : style;
    return { ...rest, id, bind: null, visible: true, props: { ...object(rest.props), blocks: [{ ...block, id: `${id}_b`, ...(ref ? { style_ref: ref } : {}), runs: [{ ...run, text: '' }] }] } };
  };
  const last = new Map(parts.map((part) => [part.id, array(part.nodes)[array(part.nodes).length - 1]]));
  const base = new Map(parts.map((part) => [part.id, part]));
  for (const add of added) {
    const id = clean(add.id), anchor = base.get(clean(add.after)), after = last.get(clean(add.after));
    if (!id || !after || last.has(id) || where.has(`${id}_h`) || where.has(`${id}_t`)) continue;
    last.set(id, after);
    if (anchor) base.set(id, anchor);
    const spot = where.get(after);
    if (!spot) continue;
    const headingFrom = like(anchor, (part) => part.heading), textFrom = like(anchor, (part) => array(part.texts)[0]) || headingFrom;
    const made = [];
    if (words(`${id}_h`) && (headingFrom || textFrom)) made.push(headingFrom ? make(headingFrom, `${id}_h`) : make(textFrom, `${id}_h`, 'h3'));
    if (words(`${id}_t`) && textFrom) made.push(make(textFrom, `${id}_t`, textFrom === headingFrom ? '' : undefined));
    if (!made.length) continue;
    spot.siblings.splice(spot.siblings.indexOf(spot.node) + 1, 0, ...made);
    for (const node of made) { where.set(node.id, { node, siblings: spot.siblings }); allowed.add(node.id); }
    last.set(id, made[made.length - 1].id);
  }
  for (const part of parts) {
    if (!part.removable || !removed.includes(part.id)) continue;
    for (const id of array(part.nodes)) { const spot = where.get(id); const at = spot ? spot.siblings.indexOf(spot.node) : -1; if (at >= 0) spot.siblings.splice(at, 1); allowed.delete(id); }
  }
  const plain = (node) => array(object(node.props).blocks).map((block) => array(object(block).runs).map((run) => String(object(run).text ?? '')).join('')).join('\n\n');
  for (const [id, value] of Object.entries(copy)) {
    const node = where.get(id)?.node;
    if (typeof value !== 'string' || !node || !allowed.has(id) || node.type !== 'text' || value === plain(node)) continue;
    const props = object(node.props), blocks = array(props.blocks).map(object);
    const paragraphs = value.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    props.blocks = (paragraphs.length ? paragraphs : ['']).map((part, at) => {
      const like = blocks[Math.min(at, blocks.length - 1)] || {};
      const { text: _text, ...run } = object(array(like.runs)[0]);
      return { ...like, id: clean(blocks[at]?.id) || `${clean(blocks[0]?.id) || 'blk'}_${at}`, runs: [{ ...run, text: part }] };
    });
    node.props = props;
  }
  return definition;
}

/**
 * The document carried from one step to the next (FM-614): the style chosen moves to the right of its wording, and from
 * there into the first proposal's preview. A step leaving keeps a copy of its document and where it was; the next lays
 * it over the page and glides it into its own place, and lets it go once its own document is drawn.
 */
let handoff = null;
function keepDocument(node){
  if (!node?.isConnected) return;
  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ghost = node.cloneNode(true);
  ghost.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'));
  handoff = { at: Date.now(), rect, ghost, scroll: node.scrollTop || 0 };
}
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
/** Lays the carried document where it was, over `container`; null when there is none to carry. */
function liftDocument(container){
  const from = handoff; handoff = null;
  if (!from || Date.now() - from.at > 3000 || reducedMotion() || !container) return null;
  const ghost = from.ghost;
  ghost.classList.add('gxd-ghost-doc');
  ghost.setAttribute('aria-hidden', 'true');
  // `inset` first: set after them, the shorthand would clear left and top and drop the document mid-sheet (GP-13).
  Object.assign(ghost.style, { inset: 'auto', left: `${from.rect.left}px`, top: `${from.rect.top}px`, width: `${from.rect.width}px`, height: `${from.rect.height}px`, transform: '' });
  container.append(ghost);
  ghost.scrollTop = from.scroll;
  return { ghost, rect: from.rect };
}
/** Where an element will be once its step has slid into place (the player slides a new step in from below). */
function settledRect(target){
  const rect = target.getBoundingClientRect(), pane = target.closest('.gxs-step');
  if (!pane?.offsetParent) return rect;
  const shift = pane.getBoundingClientRect().top - (pane.offsetParent.getBoundingClientRect().top + pane.offsetTop + pane.offsetParent.clientTop);
  return { left: rect.left, top: rect.top - shift, width: rect.width, height: rect.height };
}
function glide(lifted, target){
  if (!lifted || !target?.isConnected) return;
  glideTo(lifted, settledRect(target));
}
function glideTo(lifted, to){
  const from = lifted?.rect;
  if (!from || !to?.width) return;
  const scale = to.width / from.width;
  lifted.ghost.style.height = `${Math.min(from.height, to.height / scale)}px`;
  requestAnimationFrame(() => { lifted.ghost.style.transform = `translate(${to.left - from.left}px,${to.top - from.top}px) scale(${scale})`; });
}
function drop(lifted){
  if (!lifted || lifted.dropped) return;
  lifted.dropped = true;
  lifted.ghost.style.opacity = '0';
  setTimeout(() => lifted.ghost.remove(), 320);
}

/**
 * Saves the organization's own template for the kind now, with the answers so far (documents.setup.apply, as the finish
 * does): Advanced opens it and the first proposal is made from it (FM-614). The finish saves it again, which changes
 * nothing when nothing has changed since.
 */
async function saveTemplate(ctx, selections, extra = {}){
  const input = { ...answersOf(selections), theme_id: clean(selections.theme_id), prices: array(selections.prices),
    copy: object(selections.copy), copy_sections: sectionChanges(selections.copy_sections), keep_edits: selections.keep_edits === true, ...extra };
  // Both kinds of proposals: the insurance agreement's wording page is its own (GP-55).
  if (proposalKinds(selections) === 'both') Object.assign(input, { insurance_copy: object(selections.insurance_copy), insurance_copy_sections: sectionChanges(selections.insurance_copy_sections), insurance_keep_edits: selections.insurance_keep_edits === true }, extra);
  // The price step's lines (FM-610): the first proposal is priced from them.
  if (selections.lines && typeof selections.lines === 'object') input.lines = selections.lines;
  const result = await window.PlatformAPI.publication.invoke(ctx.orgId, 'documents.setup.apply', { scope: 'organization', organizationId: ctx.orgId }, input, { idempotencyKey: `documents.setup.save:${ctx.orgId}:${Date.now()}:${Math.random().toString(36).slice(2)}` });
  return object(result?.value ?? result?.result ?? result);
}

/** Parts of the wording removed and added on the copy step (GP-97), as the finish takes them. */
function sectionChanges(value){
  return { removed: array(object(value).removed).map(clean).filter(Boolean), added: array(object(value).added).map(object).filter((add) => clean(add.id) && clean(add.after)).map((add) => ({ id: clean(add.id), after: clean(add.after) })) };
}
/** The parts of the wording from its fields alone, for a server that sends none: each heading and the text under it; none removable. */
function partsOf(fields){
  const parts = [];
  let open = null;
  for (const field of array(fields).map(object)) {
    const id = clean(field.node_id);
    if (field.role === 'title' || field.role === 'heading') parts.push(open = { id, heading: id, texts: [], nodes: [id], title: field.role === 'title', removable: false });
    else if (open) { open.texts.push(id); open.nodes.push(id); }
    else parts.push(open = { id, heading: null, texts: [id], nodes: [id], removable: false });
  }
  return parts;
}
/** Retail, insurance or both (GP-55): retail for any other kind of document, and for a company never asked. */
function proposalKinds(selections){
  return clean(selections.document_kind) === 'proposal' && ['insurance', 'both'].includes(clean(selections.proposal_kinds)) ? clean(selections.proposal_kinds) : 'retail';
}
/** What the server is told the answers are (document-setup previews and copy, documents.setup.apply). */
function answersOf(selections){
  const args = { document_kind: clean(selections.document_kind) || 'proposal' };
  if (args.document_kind !== 'proposal') return args;
  const kinds = proposalKinds(selections);
  if (kinds !== 'retail') args.proposal_kinds = kinds;
  if (kinds !== 'insurance') for (const name of ['presentation', 'customer_changes', 'detail', 'scope_write_up']) if (selections[name] !== undefined) args[name] = selections[name];
  return args;
}
/**
 * The setups (their selections) that went on past the proposal kinds step without showing it, because the company does
 * no insurance work: coming back to it, Back goes on to the step before it.
 */
const passedKinds = new WeakSet();

/**
 * The setups (their selections) whose style step has shown this run: Back to it keeps the style picked. Otherwise it
 * opens on the style the previews name (the kind's own, or the company's first style, GP-102), not one a replay of an
 * earlier setup for another kind carried in.
 */
const styled = new WeakSet();

/** The questions with one answer each: the choices, with their copy (gx_docs_setup_* keys). */
function choicesFor(part, selections){
  const c = (id, icon, key, title, hint, value = id) => ({ id, icon, value, title: [`gx_docs_setup_${key}`, title], hint: [`gx_docs_setup_${key}_hint`, hint] });
  if (part === 'kind') return { key: 'document_kind', choices: [
    c('proposal', 'fa-file-signature', 'kind_proposal', 'Proposal', 'Price the work for your customer to approve and sign.'),
    c('invoice', 'fa-file-invoice-dollar', 'kind_invoice', 'Invoice', 'Bill a deposit, the balance or extra charges.'),
    c('change_order', 'fa-pen-to-square', 'kind_change_order', 'Change order', 'Add or change work on a signed agreement.'),
    c('completion_certificate', 'fa-award', 'kind_certificate', 'Completion certificate', 'Your customer signs off that the work is done.')
  ] };
  if (part === 'presentation') return { key: 'presentation', choices: [
    c('options', 'fa-layer-group', 'presentation_options', 'Several options to choose from', 'Different choices of work, each with its own price.'),
    c('single', 'fa-file-lines', 'presentation_single', 'One estimate', 'The work you recommend, at one price.')
  ] };
  if (part === 'changes') return { key: 'customer_changes', choices: clean(selections.presentation) === 'options' ? [
    c('mix', 'fa-shuffle', 'changes_mix', 'They can mix and match', 'Your customer swaps line items between the options before signing.'),
    c('pick', 'fa-hand-pointer', 'changes_pick', 'They pick one of the options', 'Each option stays as you wrote it.')
  ] : [
    c('mix', 'fa-sliders', 'changes_mix_single', 'They can add or remove items', 'Optional items your customer turns on or off before signing.'),
    c('ask', 'fa-comments', 'changes_ask', 'They talk to us', 'Any change means a new estimate from you.')
  ] };
  if (part === 'detail') return { key: 'detail', choices: [
    c('itemized', 'fa-list-check', 'detail_itemized', 'Every line item', 'Built from the job’s exact scope of work, down to each material and the labor.'),
    c('rough', 'fa-ruler-combined', 'detail_rough', 'A broad estimate', 'Based on the broad materials selected and the job’s overall measurements.')
  ] };
  if (part === 'scope') return { key: 'scope_write_up', choices: [
    c('yes', 'fa-images', 'scope_yes', 'Yes, a description and photos', 'What you found and what you’ll do, then the price.', true),
    c('no', 'fa-file-contract', 'scope_no', 'No, just the proposal', 'The price and what’s included.', false)
  ] };
  return null;
}

export function mount(el, ctx){
  installStyle();
  const { esc } = ctx;
  const L = (copy) => ctx.L(copy[0], copy[1]);
  const t = (key, text) => ctx.L(`gx_docs_setup_${key}`, text);
  const part = clean(ctx.options.part);
  const selections = object(ctx.selections);
  if (part === 'prices') return pricesPart();
  if (part === 'style') return stylePart();
  if (part === 'copy') return copyPart();
  if (part === 'first') return firstPart();
  if (part === 'proposal_kinds') return kindsPart();
  const question = choicesFor(part, selections);
  if (!question) { el.innerHTML = `<p class="gxd-error">${esc(t('unknown', 'This step cannot be shown here.'))}</p>`; return { valid: () => false }; }

  // ── One answer from a few choices ─────────────────────────────────────
  const { key, choices } = question;
  const valueOf = (choice) => choice.value;
  // Most people start with a proposal (FM-582): on the first question it is the large choice, already picked, and the
  // other kinds sit in a smaller row below it. Its size says it is the one to start with: no badge (FM-615).
  const featured = part === 'kind' ? choices.find((choice) => choice.id === 'proposal') : null;
  let chosen = choices.find((choice) => valueOf(choice) === selections[key]) || featured || null;
  // A tile of the standard choice row (GP-46) carries the shared .gxs-choice classes; the first question's are its own.
  const tileHtml = (choice, big = false, row = !featured) => `
    <button type="button" class="gxd-tile${big ? ' gxd-feature' : ''}${row ? ' gxs-choice' : ''}" role="radio" data-choice="${esc(choice.id)}" aria-checked="${chosen === choice}">
      <span class="gxd-icon${row ? ' gxs-choice-icon' : ''}" aria-hidden="true"><i class="fas ${esc(choice.icon)}"></i></span>
      <span${row ? ' class="gxs-choice-text"' : ''}><strong>${esc(L(choice.title))}</strong><small>${esc(L(choice.hint))}</small></span>${row ? choiceTick : tick}
    </button>`;
  const others = choices.filter((choice) => choice !== featured);
  el.innerHTML = `<div class="gxd"><div role="radiogroup" aria-label="${esc(ctx.L(ctx.step.title))}" class="gxd-group">${featured
    ? `${tileHtml(featured, true)}<p class="gxd-others">${esc(t('kind_others', 'Or set up another kind of document'))}</p><div class="gxd-grid gxd-small">${others.map((choice) => tileHtml(choice)).join('')}</div>`
    : `<div class="gxs-choices" style="--gxs-n:${choices.length}">${choices.map((choice) => tileHtml(choice)).join('')}</div>`}</div></div>`;
  const report = () => ctx.change(chosen ? { [key]: valueOf(chosen) } : {}, chosen ? L(chosen.title) : '');
  const onClick = (event) => {
    const tile = event.target.closest('[data-choice]'); if (!tile) return;
    chosen = choices.find((choice) => choice.id === tile.dataset.choice) || null;
    el.querySelectorAll('[data-choice]').forEach((node) => node.setAttribute('aria-checked', String(node.dataset.choice === chosen?.id)));
    report();
  };
  el.addEventListener('click', onClick);
  if (chosen) report();
  return {
    valid: () => !!chosen,
    hint: () => t('choose_hint', 'Choose the answer that fits best.'),
    summary: () => chosen ? L(chosen.title) : '',
    destroy(){ el.removeEventListener('click', onClick); }
  };

  // ── Prices (optional) ─────────────────────────────────────────────────
  // The lines a proposal is made of (the price book's roof replacement), each with its price and a switch, in two
  // columns of the wide sheet (FM-610). It starts with two ways in: go through the prices by hand, or upload estimates
  // they already send, as many as they have, on a page of its own (GP-51), which are read into the same lines to check. A line can be added from the rest of the price book
  // by name, or made new with its quantity from the measurements. The finish writes it all (documents.setup.apply).
  function pricesPart(){
    let alive = true, sheet = null, lines = [], editor = null, banner = null, picker = null, newCount = 0;
    const sheetEl = el.closest('.gxs'), wasWide = !!sheetEl?.classList.contains('gxs-wide');
    sheetEl?.classList.add('gxs-wide');
    const pane = el.closest('.gxs-step'), wasFill = !!pane?.hasAttribute('data-fill');
    const given = new Map(array(selections.prices).map((entry) => [clean(entry.item_id), Number(entry.unit_price)]));
    const givenLines = selections.lines && typeof selections.lines === 'object' ? selections.lines : null;
    el.innerHTML = '<div class="gxd"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
    const unitLabel = (unit) => ({ sq: t('unit_sq', 'per square'), lf: t('unit_lf', 'per foot'), ft: t('unit_lf', 'per foot'), ea: t('unit_ea', 'each'), job: t('unit_job', 'per job'), bundle: t('unit_bundle', 'per bundle'), hour: t('unit_hour', 'per hour') }[clean(unit).toLowerCase()] || (unit ? `/ ${unit}` : ''));
    const measureLabel = (key) => array(sheet?.measurements).find((field) => field.key === key)?.label || key;
    const priceText = (value) => value == null || !Number.isFinite(Number(value)) ? '' : String(Math.round(Number(value) * 100) / 100);
    const typed = (line) => { const value = Number(String(line.price ?? '').replace(/[^0-9.]/g, '')); return clean(line.price) === '' || !Number.isFinite(value) ? null : Math.round(value * 100) / 100; };
    /** A new line's quantity in words, from its terms. */
    const termsText = (terms) => terms.map((term) => term.key === '' ? t('prices_term_per_job', '{count} per job').replace('{count}', String(term.factor)) : `${Number(term.factor) !== 1 ? `${term.factor} × ` : ''}${measureLabel(term.key)}`).join(' + ');
    const tokensOf = (terms) => terms.flatMap((term, at) => [...(at ? [{ type: 'operator', value: '+' }] : []), ...(term.key === ''
      ? [{ type: 'number', value: String(term.factor) }]
      : Number(term.factor) !== 1 ? [{ type: 'number', value: String(term.factor) }, { type: 'operator', value: '*' }, { type: 'measurement', value: term.key }] : [{ type: 'measurement', value: term.key }])]);
    /** Tokens back into terms where they are a sum of (factor ×) measurements or numbers; else one fixed number. */
    function termsOf(tokens){
      const terms = []; let factor = 1;
      for (let at = 0; at < tokens.length; at += 1) {
        const token = tokens[at], following = tokens[at + 1];
        if (token.type === 'number' && following?.type === 'operator' && following.value === '*' && tokens[at + 2]?.type === 'measurement') { factor = Number(token.value); at += 1; continue; }
        if (token.type === 'measurement') { terms.push({ factor, key: token.value }); factor = 1; continue; }
        if (token.type === 'number') { terms.push({ factor: Number(token.value), key: '' }); continue; }
        if (token.type === 'operator' && token.value === '+') continue;
        return null;
      }
      return terms.length ? terms : null;
    }
    // A picture for each line, so the list reads at a glance (Jack: not a wall of text): from its name, else its category.
    const ICONS = [
      [/tear|remov|dispos|dumpster|haul/, 'fa-dumpster'], [/ice|water shield|leak barrier|weatherwatch|weatherlock/, 'fa-snowflake'],
      [/underlay|felt|tiger paw|feltbuster|synthetic/, 'fa-scroll'], [/starter/, 'fa-grip-lines'], [/ridge vent|intake|vent/, 'fa-wind'],
      [/ridge|hip/, 'fa-mountain'], [/drip/, 'fa-droplet'], [/valley/, 'fa-angles-down'], [/chimney/, 'fa-house-chimney'],
      [/skylight/, 'fa-sun'], [/pipe|boot|jack/, 'fa-circle-dot'], [/downspout/, 'fa-arrow-down-long'], [/gutter/, 'fa-water'],
      [/steep|pitch|slope charge/, 'fa-arrow-trend-up'], [/warrant/, 'fa-shield-halved'], [/flash|step|head ?wall|side ?wall|termination|transition/, 'fa-shapes'],
      [/deck|plywood|osb|sheathing/, 'fa-border-all'], [/permit/, 'fa-file-signature'], [/labor|labour|install/, 'fa-helmet-safety'],
      [/shingle|timberline|duration|vista|sequoia|shake|three.tab|architectural|laminated/, 'fa-layer-group'], [/tpo|membrane|torch|epdm|pvc|flat/, 'fa-square'], [/drain/, 'fa-filter']
    ];
    const CATEGORY_ICONS = { disposal: 'fa-dumpster', shingle_roofs: 'fa-layer-group', leak_barriers: 'fa-snowflake', underlayments: 'fa-scroll', flashing: 'fa-shapes', accessories: 'fa-puzzle-piece', gutters: 'fa-water', flat_roofs: 'fa-square', flat_roof_accessories: 'fa-shapes' };
    const iconFor = (line) => ICONS.find(([pattern]) => pattern.test(`${line.name} ${line.id}`.toLowerCase()))?.[1] || CATEGORY_ICONS[line.category] || 'fa-box';
    const lineFrom = (item, on) => ({ id: item.id, name: item.name, unit: item.unit, category: item.category, book: item.unit_price, price: priceText(given.has(item.id) ? given.get(item.id) : item.unit_price), on, formula: item.formula, isNew: false, initial: on });

    // ── What the step answers ──
    const changedPrices = () => lines.filter((line) => !line.isNew).map((line) => { const value = typed(line); return value != null && value !== line.book ? { item_id: line.id, unit_price: value } : null; }).filter(Boolean);
    const linesAnswer = () => {
      if (!sheet?.editable) return null;
      const on = lines.filter((line) => line.on);
      const initial = array(sheet.items).filter((item) => item.on).map((item) => item.id);
      const same = !lines.some((line) => line.isNew && line.on) && on.length === initial.length && on.every((line, at) => line.id === initial[at]);
      if (same) return null;
      return { on: on.map((line) => line.id), new_items: on.filter((line) => line.isNew).map((line) => ({ key: line.id, name: line.name, unit: line.unit, unit_price: typed(line) ?? 0, formula: tokensOf(line.terms), include_waste: !!line.waste })) };
    };
    const summaryText = () => {
      const prices = changedPrices().length, answer = linesAnswer();
      const parts = [];
      if (answer) parts.push((answer.on.length === 1 ? t('prices_summary_line', '1 line') : t('prices_summary_lines', '{count} lines')).replace('{count}', String(answer.on.length)));
      if (prices) parts.push((prices === 1 ? t('prices_summary_one', '1 price') : t('prices_summary', '{count} prices')).replace('{count}', String(prices)));
      return parts.join(' · ');
    };
    const report = () => { const answer = linesAnswer(); const patch = { prices: changedPrices() }; if (answer) patch.lines = answer; else patch.lines = undefined; ctx.change(patch, summaryText()); };

    // ── Drawing ──
    const lineHtml = (line) => `
      <div class="gxd-line" data-line="${esc(line.id)}" data-on="${line.on}">
        <span class="gxd-icon" aria-hidden="true"><i class="fas ${esc(iconFor(line))}"></i></span>
        <span class="gxd-line-main"><strong title="${esc(line.name)}">${esc(line.name)}</strong><small>${esc(line.isNew ? termsText(line.terms) : line.formula || '')}${line.fromEstimate ? `<em class="gxd-tag">${esc(t('prices_from_estimate', 'From your estimate'))}</em>` : line.isNew ? `<em class="gxd-tag">${esc(t('prices_new_line', 'New'))}</em>` : ''}</small></span>
        <label class="gxd-money"><span>$</span><input inputmode="decimal" autocomplete="off" data-price="${esc(line.id)}" value="${esc(line.price)}" placeholder="0.00" aria-label="${esc(line.name)}"><span>${esc(unitLabel(line.unit))}</span></label>
        ${line.isNew ? `<button type="button" class="gxd-icon-btn gxd-edit" data-edit="${esc(line.id)}" aria-label="${esc(t('prices_edit_line', 'Change {name}').replace('{name}', line.name))}" title="${esc(t('prices_edit_line', 'Change {name}').replace('{name}', line.name))}"><i class="fas fa-pen" aria-hidden="true"></i></button>` : ''}
        ${sheet.editable ? `<button type="button" class="gxd-switch" role="switch" data-toggle="${esc(line.id)}" aria-checked="${line.on}" aria-label="${esc(t('prices_use_line', 'Use {name}').replace('{name}', line.name))}" title="${esc(line.on ? t('prices_line_on', 'On your proposals') : t('prices_line_off', 'Not on your proposals'))}"><span></span></button>` : ''}
      </div>`;
    function startHtml(){
      return `<div class="gxd">
        <p>${esc(t('prices_start_lead', 'Your proposals are priced from these lines. Start from an estimate you already send, or go through them yourself.'))}</p>
        <div class="gxs-choices" style="--gxs-n:2" role="group" aria-label="${esc(ctx.L(ctx.step.title))}">
          <button type="button" class="gxd-tile gxs-choice" data-start="estimate"><span class="gxd-icon gxs-choice-icon" aria-hidden="true"><i class="fas fa-file-arrow-up"></i></span><span class="gxs-choice-text"><em class="gxd-badge">${esc(t('prices_start_fastest', 'Fastest'))}</em><strong>${esc(t('prices_start_estimates', 'Upload existing estimates'))}</strong><small>${esc(t('prices_start_estimates_hint', 'We’ll read through these to set up your prices.'))}</small></span></button>
          <button type="button" class="gxd-tile gxs-choice" data-start="manual"><span class="gxd-icon gxs-choice-icon" aria-hidden="true"><i class="fas fa-list-check"></i></span><span class="gxs-choice-text"><strong>${esc(t('prices_start_manual', 'Review my prices manually'))}</strong><small>${esc(t('prices_start_manual_hint', 'Go through the usual lines of a roof and set what you charge for each.'))}</small></span></button>
        </div>
        <p class="gxd-error" role="alert" data-error></p>
      </div>`;
    }
    function listHtml(){
      return `<div class="gxd">
        <div class="gxd-lead"><p>${esc(t('prices_lead_2', 'What you charge your customer for each line, before tax. Turn off what you don’t use.'))}</p>
          <button type="button" class="gxd-upload" data-upload><i class="fas fa-file-arrow-up" aria-hidden="true"></i>${esc(estimates.length ? t('prices_upload_more', 'Add more estimates') : t('prices_upload_2', 'Upload existing estimates'))}</button></div>
        ${banner ? `<div class="gxd-banner" role="status"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i><span>${esc(banner)}</span></div>` : ''}
        <p class="gxd-error" role="alert" data-error></p>
        <div class="gxd-lines">${lines.map((line) => editor?.editing === line.id ? editorHtml() : lineHtml(line)).join('')}${sheet.editable ? (editor && !editor.editing ? editorHtml() : `<button type="button" class="gxd-add" data-add><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('prices_add_line', 'Add a line item'))}</button>`) : ''}</div>
        <p class="gxd-note">${esc(t('prices_note', 'You can change your default prices in your price book at any time, and any price on a single proposal while you write it.'))}</p>
      </div>`;
    }
    // The estimates page (GP-51): what has been uploaded so far, each with how its reading went, and a way to add more.
    const fileIcon = (entry) => entry.type === 'application/pdf' || /\.pdf$/i.test(entry.name) ? 'fa-file-pdf' : 'fa-file-image';
    const pendingEstimates = () => estimates.filter((entry) => entry.state === 'waiting' || entry.state === 'reading').length;
    const readEstimates = () => estimates.filter((entry) => entry.state === 'done' && array(entry.result?.lines).length);
    function estimateHtml(entry){
      const count = array(entry.result?.lines).length, waiting = entry.state === 'waiting' || entry.state === 'reading';
      const status = entry.state === 'failed' ? entry.error
        : waiting ? t('prices_estimate_reading', 'Reading…')
        : count ? (count === 1 ? t('prices_estimate_line', '1 priced line') : t('prices_estimate_lines', '{count} priced lines').replace('{count}', String(count)))
        : t('prices_estimate_no_lines', 'No priced lines found');
      return `<li class="gxd-file" data-estimate="${esc(entry.id)}" data-state="${esc(entry.state)}">
        <span class="gxd-icon" aria-hidden="true">${waiting ? '<span class="gxs-spin"></span>' : `<i class="fas ${entry.state === 'failed' ? 'fa-triangle-exclamation' : fileIcon(entry)}"></i>`}</span>
        <span class="gxd-line-main"><strong title="${esc(entry.name)}">${esc(entry.name)}</strong><small title="${esc(entry.state === 'done' ? clean(entry.result?.notes) : '')}">${esc(status)}</small></span>
        ${entry.state === 'done' && count ? '<i class="fas fa-circle-check gxd-file-ok" aria-hidden="true"></i>' : ''}
        <button type="button" class="gxd-icon-btn" data-remove-estimate="${esc(entry.id)}" aria-label="${esc(t('prices_estimate_remove', 'Remove {name}').replace('{name}', entry.name))}" title="${esc(t('prices_estimate_remove', 'Remove {name}').replace('{name}', entry.name))}">&times;</button>
      </li>`;
    }
    const uploadsDoneHtml = () => pendingEstimates() ? `<span class="gxs-spin" aria-hidden="true"></span>${esc(t('prices_estimate_reading', 'Reading…'))}` : esc(t('prices_uploads_continue', 'Continue'));
    function uploadsHtml(){
      return `<div class="gxd gxd-uploads">
        <p>${esc(t('prices_start_estimates_hint', 'We’ll read through these to set up your prices.'))}</p>
        <ul class="gxd-files" data-estimates aria-live="polite">${estimates.map(estimateHtml).join('')}</ul>
        <button type="button" class="gxd-add gxd-drop" data-add-estimates><i class="fas fa-file-arrow-up" aria-hidden="true"></i><span><strong>${esc(estimates.length ? t('prices_upload_more', 'Add more estimates') : t('prices_uploads_choose', 'Choose estimates'))}</strong><small>${esc(t('prices_uploads_kinds', 'PDFs or photos, up to 20 MB each'))}</small></span></button>
        <p class="gxd-banner gxd-more"><i class="fas fa-lightbulb" aria-hidden="true"></i><span>${esc(t('prices_uploads_more', 'The more estimates you upload, the better we can work out your prices.'))}</span></p>
        <p class="gxd-error" role="alert" data-error></p>
        <div class="gxd-uploads-foot"><button type="button" class="gxs-btn ghost" data-uploads-back>${esc(t('prices_uploads_back', 'Back'))}</button><button type="button" class="gxs-btn primary" data-uploads-done${pendingEstimates() || !readEstimates().length ? ' disabled' : ''}>${uploadsDoneHtml()}</button></div>
      </div>`;
    }
    /** Only the list and Continue, so a reading that finishes leaves the rest (and focus) alone. */
    function drawUploads(){
      if (!alive || phase !== 'uploads') return;
      const host = el.querySelector('[data-estimates]'); if (!host) return draw();
      host.innerHTML = estimates.map(estimateHtml).join('');
      const add = el.querySelector('[data-add-estimates] strong'); if (add) add.textContent = estimates.length ? t('prices_upload_more', 'Add more estimates') : t('prices_uploads_choose', 'Choose estimates');
      const done = el.querySelector('[data-uploads-done]'); if (done) { done.disabled = !!pendingEstimates() || !readEstimates().length; done.innerHTML = uploadsDoneHtml(); }
    }
    // ── Adding a line: a name, from the price book or new ──
    const suggestions = (query) => {
      const words = clean(query).toLowerCase().split(/\s+/).filter(Boolean);
      const taken = new Set(lines.map((line) => line.id));
      return array(sheet.catalog).filter((item) => !taken.has(item.id) && words.every((word) => `${item.name} ${item.formula}`.toLowerCase().includes(word))).slice(0, 8);
    };
    function suggestHtml(){
      if (!editor || editor.stage !== 'name' || !clean(editor.name)) return '';
      const found = suggestions(editor.name);
      return `<div class="gxd-suggest" role="listbox" aria-label="${esc(t('prices_add_from_book', 'From your price book'))}">
        ${found.map((item, at) => `<button type="button" role="option" class="gxd-option" data-pick="${esc(item.id)}" aria-selected="${at === editor.active}"><i class="fas ${esc(iconFor(item))}" aria-hidden="true"></i><span><strong>${esc(item.name)}</strong><small>${esc([unitLabel(item.unit), item.unit_price != null ? `$${priceText(item.unit_price)}` : ''].filter(Boolean).join(' · '))}</small></span></button>`).join('')}
        <button type="button" role="option" class="gxd-option gxd-option-new" data-pick="" aria-selected="${editor.active === found.length}"><i class="fas fa-plus" aria-hidden="true"></i><span><strong>${esc(t('prices_make_new', 'Make a new line “{name}”').replace('{name}', clean(editor.name)))}</strong><small>${esc(t('prices_make_new_hint', 'Not in your price book: set its price and how much goes on each job.'))}</small></span></button>
      </div>`;
    }
    function editorHtml(){
      const measures = array(sheet.measurements);
      if (editor.stage === 'name') return `<div class="gxd-editor" data-editor>
        <div class="gxd-field gxd-name"><label for="gxd-new-name">${esc(t('prices_add_name', 'Line item'))}</label>
          <input id="gxd-new-name" data-new-name autocomplete="off" value="${esc(editor.name)}" placeholder="${esc(t('prices_add_placeholder', 'Start typing, e.g. chimney flashing'))}" role="combobox" aria-expanded="${!!clean(editor.name)}" aria-autocomplete="list">
          <div data-suggest>${suggestHtml()}</div></div>
        <div class="gxd-editor-actions"><button type="button" class="gxd-link" data-cancel>${esc(t('prices_add_cancel', 'Cancel'))}</button></div>
      </div>`;
      const termRow = (term, at) => `<div class="gxd-term" data-term="${at}">
        ${at ? '<span class="gxd-plus" aria-hidden="true">+</span>' : ''}
        <input class="gxd-factor" data-factor="${at}" inputmode="decimal" value="${esc(String(term.factor))}" aria-label="${esc(t('prices_term_factor', 'How many'))}">
        <span class="gxd-times" aria-hidden="true">${term.key === '' ? '' : '×'}</span>
        <select data-measure="${at}" aria-label="${esc(t('prices_term_measure', 'Measurement'))}">
          <option value=""${term.key === '' ? ' selected' : ''}>${esc(t('prices_term_fixed', 'per job (a fixed number)'))}</option>
          ${measures.map((field) => `<option value="${esc(field.key)}"${field.key === term.key ? ' selected' : ''}>${esc(field.label)}</option>`).join('')}
        </select>
        ${editor.terms.length > 1 ? `<button type="button" class="gxd-icon-btn" data-drop-term="${at}" aria-label="${esc(t('prices_term_remove', 'Remove'))}">&times;</button>` : ''}
      </div>`;
      return `<div class="gxd-editor gxd-editor-new" data-editor>
        <div class="gxd-editor-row">
          <div class="gxd-field gxd-name"><label for="gxd-new-name">${esc(t('prices_add_name', 'Line item'))}</label><input id="gxd-new-name" data-new-name autocomplete="off" value="${esc(editor.name)}"></div>
          <div class="gxd-field"><label for="gxd-new-unit">${esc(t('prices_add_unit', 'Sold'))}</label><select id="gxd-new-unit" data-new-unit>${['sq', 'lf', 'ea'].map((unit) => `<option value="${unit}"${unit === editor.unit ? ' selected' : ''}>${esc(unitLabel(unit))}</option>`).join('')}</select></div>
          <div class="gxd-field"><label for="gxd-new-price">${esc(t('prices_add_price', 'Price'))}</label><span class="gxd-money"><span>$</span><input id="gxd-new-price" data-new-price inputmode="decimal" autocomplete="off" value="${esc(editor.price)}" placeholder="0.00"></span></div>
        </div>
        <div class="gxd-field"><span class="gxd-label">${esc(t('prices_add_quantity', 'How much goes on each job'))}</span>
          <div class="gxd-terms">${editor.terms.map(termRow).join('')}</div>
          <div class="gxd-term-actions"><button type="button" class="gxd-link" data-add-term><i class="fas fa-plus" aria-hidden="true"></i> ${esc(t('prices_term_add', 'Add a measurement'))}</button>
            ${editor.unit === 'sq' ? `<label class="gxd-check"><input type="checkbox" data-new-waste${editor.waste ? ' checked' : ''}> ${esc(t('prices_add_waste', 'Add the roof’s waste'))}</label>` : ''}</div>
          <small class="gxd-hint">${esc(t('prices_add_quantity_hint', 'Worked out from each job’s measurements. For example, starter strip is Eaves + Rakes.'))}</small>
        </div>
        <p class="gxd-error" role="alert" data-editor-error></p>
        <div class="gxd-editor-actions"><button type="button" class="gxd-link" data-cancel>${esc(t('prices_add_cancel', 'Cancel'))}</button><button type="button" class="gxd-btn" data-save-new>${esc(editor.editing ? t('prices_edit_save', 'Save line') : t('prices_add_save', 'Add line'))}</button></div>
      </div>`;
    }
    let phase = 'start';
    function draw(focus){
      if (!alive) return;
      el.innerHTML = phase === 'uploads' ? uploadsHtml() : phase === 'start' ? startHtml() : listHtml();
      if (focus) el.querySelector(focus)?.focus({ preventScroll: false });
    }
    /** Only the suggestions under the name box, so typing keeps its focus and caret. */
    function drawSuggestions(){ const host = el.querySelector('[data-suggest]'); if (host) host.innerHTML = suggestHtml(); el.querySelector('[data-new-name]')?.setAttribute('aria-expanded', String(!!clean(editor?.name))); }
    const showError = (message, selector = '[data-error]') => { const node = el.querySelector(selector); if (node) node.textContent = message; };

    function addFromBook(id){
      const item = array(sheet.catalog).find((entry) => entry.id === id); if (!item) return;
      lines.push({ ...lineFrom(item, true), initial: false });
      editor = null; draw(`[data-price="${CSS.escape(id)}"]`); report();
    }
    function saveNew(){
      const name = clean(editor.name);
      if (!name) { showError(t('prices_add_need_name', 'Give the line a name.'), '[data-editor-error]'); return; }
      if (editor.terms.some((term) => !(Number(term.factor) >= 0) || clean(term.factor) === '')) { showError(t('prices_add_need_factor', 'Each amount needs a number.'), '[data-editor-error]'); return; }
      const fields = { name, unit: editor.unit, price: editor.price, terms: editor.terms.map((term) => ({ factor: Number(term.factor), key: term.key })), waste: editor.unit === 'sq' && !!editor.waste };
      const editing = lines.find((line) => line.id === editor.editing);
      let id = editing?.id;
      if (editing) Object.assign(editing, fields);
      else {
        newCount += 1;
        id = `new_${Date.now().toString(36)}${newCount}`.slice(0, 28);
        lines.push({ id, category: '', book: null, on: true, isNew: true, initial: false, formula: '', ...fields });
      }
      editor = null; draw(`[data-price="${CSS.escape(id)}"]`); report();
    }

    // ── Estimates they already send (GP-51) ──
    // A page of their own: each file is read as it is added (one estimate per read, two at a time), listed with how
    // that went, and more can be added. Continue puts them all into the lines at once.
    let estimates = [], estimateCount = 0, uploadsFrom = 'start', mergedKey = '';
    function openUploads(from){
      uploadsFrom = from; phase = 'uploads';
      pane?.setAttribute('data-fill', '');
      draw();
      ctx.setTitle?.(t('prices_uploads_title', 'Upload existing estimates'));
      // The page has its own Back and Continue: the sheet's footer hides, and the phone's back comes back here.
      ctx.change({}); ctx.syncBack?.();
      if (!estimates.length) upload();
    }
    function leaveUploads(to, focus){
      phase = to;
      if (!wasFill) pane?.removeAttribute('data-fill');
      ctx.setTitle?.('');
      draw(focus);
      ctx.change({}); ctx.syncBack?.();
    }
    function upload(){
      picker = document.createElement('input');
      picker.type = 'file'; picker.accept = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*'; picker.multiple = true;
      picker.addEventListener('change', () => { const files = [...(picker?.files || [])]; picker = null; if (files.length) addEstimates(files); }, { once: true });
      picker.click();
    }
    function addEstimates(files){
      for (const file of files) {
        estimateCount += 1;
        const entry = { id: `estimate_${estimateCount}`, file, name: clean(file.name) || t('prices_estimate_unnamed', 'Estimate'), type: file.type, state: 'waiting', result: null, error: '' };
        if (file.size > 20 * 1024 * 1024) { entry.state = 'failed'; entry.error = t('prices_estimate_too_large', 'That file is larger than 20 MB.'); entry.file = null; }
        estimates.push(entry);
      }
      pump(); drawUploads();
    }
    function pump(){
      while (estimates.filter((entry) => entry.state === 'reading').length < 2) {
        const entry = estimates.find((candidate) => candidate.state === 'waiting'); if (!entry) return;
        entry.state = 'reading';
        void readOne(entry);
      }
    }
    const base64 = (file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
    async function readOne(entry){
      try {
        const orgId = ctx.orgId;
        if (!orgId || !window.PlatformAPI?.publication?.invoke) throw new Error(t('prices_estimate_unavailable', 'This can’t be read here. Reload the page and try again.'));
        const payload = { files: [{ file_name: entry.name.slice(0, 200), content_type: entry.type || undefined, data_base64: await base64(entry.file) }] };
        const result = await window.PlatformAPI.publication.invoke(orgId, 'documents.setup.read_estimate', { scope: 'organization', organizationId: orgId }, payload, {});
        entry.result = object(result?.value ?? result); entry.state = 'done';
      } catch (error) {
        entry.state = 'failed'; entry.error = clean(error?.message) || t('prices_estimate_failed_one', 'This couldn’t be read. Try another file.');
      }
      entry.file = null;
      if (!alive) return;
      pump(); drawUploads();
    }
    /**
     * Every estimate read, as one: each line once, in the order they first show it, at the middle of the prices they
     * charge for it (in the unit the first one sells it by), so one unusual job doesn't set the price. A line one estimate
     * matched to the price book is that item in the others too where they word it the same.
     */
    function combined(read){
      const groups = new Map(), named = new Map();
      for (const entry of read) for (const line of array(entry.result?.lines)) if (clean(line.item_id)) named.set(clean(line.name).toLowerCase(), clean(line.item_id));
      for (const entry of read) for (const line of array(entry.result?.lines)) {
        const key = clean(line.item_id) || named.get(clean(line.name).toLowerCase()) || clean(line.name).toLowerCase(); if (!key) continue;
        const price = Number(line.unit_price), group = groups.get(key);
        if (!group) { groups.set(key, { ...line, prices: Number.isFinite(price) ? [price] : [] }); continue; }
        if (line.unit === group.unit && Number.isFinite(price)) group.prices.push(price);
        if (!array(group.formula).length && array(line.formula).length) group.formula = line.formula;
      }
      let differ = false;
      const found = [...groups.values()].map(({ prices, ...line }) => {
        const sorted = prices.sort((x, y) => x - y), half = Math.floor(sorted.length / 2);
        if (sorted.length > 1 && sorted[0] !== sorted.at(-1)) differ = true;
        const middle = !sorted.length ? line.unit_price : sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
        return { ...line, unit_price: Math.round(Number(middle) * 100) / 100 };
      });
      return { lines: found, differ };
    }
    /** The estimates' lines into the step: matched ones on at their price, new ones added, and the rest off (its spec). */
    function merge(read){
      // Read again with more estimates: what an earlier merge made of them is replaced, not added to.
      for (const line of lines) if (line.fromEstimate && !line.isNew) { line.price = priceText(given.has(line.id) ? given.get(line.id) : line.book); line.fromEstimate = false; }
      lines = lines.filter((line) => !(line.isNew && line.fromEstimate));
      const { lines: found, differ } = combined(read);
      if (!found.length) { banner = t('prices_estimate_none', 'We couldn’t find priced lines in that estimate. Review your prices below, or try another file.'); return; }
      let matched = 0, added = 0;
      const used = new Set();
      for (const entry of found) {
        const id = clean(entry.item_id);
        let line = id ? lines.find((candidate) => candidate.id === id) : null;
        if (id && !line) { const item = array(sheet.catalog).find((candidate) => candidate.id === id); if (item) { line = { ...lineFrom(item, true), initial: false }; lines.push(line); } }
        if (line) { line.price = priceText(entry.unit_price); line.on = true; line.fromEstimate = true; used.add(line.id); matched += 1; continue; }
        if (!sheet.editable) continue;
        const terms = termsOf(array(entry.formula)) || [{ factor: 1, key: '' }];
        newCount += 1;
        const key = `new_${Date.now().toString(36)}${newCount}`.slice(0, 28);
        lines.push({ id: key, name: clean(entry.name), unit: ['sq', 'lf', 'ea'].includes(entry.unit) ? entry.unit : 'ea', category: '', book: null, price: priceText(entry.unit_price), on: true, isNew: true, initial: false, terms, waste: false, formula: '', fromEstimate: true });
        used.add(key); added += 1;
      }
      if (sheet.editable) for (const line of lines) if (!used.has(line.id)) line.on = false;
      // Their lines first, in their order (the proposal's lines follow it), then the rest.
      const order = [...used];
      lines.sort((a, b) => (used.has(a.id) ? order.indexOf(a.id) : order.length) - (used.has(b.id) ? order.indexOf(b.id) : order.length));
      const one = read.length === 1;
      const said = one
        ? t('prices_estimate_read', 'From {file}: {matched} lines matched your price book and {added} are new. Lines it doesn’t have are off. Check the prices, then continue.').replace('{file}', read[0].name)
        : t('prices_estimates_read', 'From {count} estimates: {matched} lines matched your price book and {added} are new. Lines they don’t have are off. Check the prices, then continue.').replace('{count}', String(read.length));
      banner = [said.replace('{matched}', String(matched)).replace('{added}', String(added)),
        differ ? t('prices_estimates_differ', 'Where they charge differently for a line, it has the middle price.') : '',
        one ? clean(read[0].result?.notes) : ''].filter(Boolean).join(' ');
    }
    function finishUploads(){
      const read = readEstimates();
      if (pendingEstimates() || !read.length) return;
      // Continue again with the same estimates keeps what was changed in the lines since.
      const key = read.map((entry) => entry.id).join(' ');
      if (key !== mergedKey) { merge(read); mergedKey = key; }
      leaveUploads('list', '.gxd-banner');
      report();
    }

    // ── Events ──
    const onClick = (event) => {
      const start = event.target.closest('[data-start]');
      if (start) { if (start.dataset.start === 'estimate') openUploads('start'); else { phase = 'list'; draw('.gxd-line input'); report(); } return; }
      if (event.target.closest('[data-upload]')) { openUploads('list'); return; }
      if (event.target.closest('[data-add-estimates]')) { upload(); return; }
      const remove = event.target.closest('[data-remove-estimate]');
      if (remove) { estimates = estimates.filter((entry) => entry.id !== remove.dataset.removeEstimate); drawUploads(); el.querySelector('[data-add-estimates]')?.focus(); return; }
      if (event.target.closest('[data-uploads-back]')) { leaveUploads(uploadsFrom, uploadsFrom === 'list' ? '[data-upload]' : '[data-start="estimate"]'); return; }
      if (event.target.closest('[data-uploads-done]')) { finishUploads(); return; }
      const toggle = event.target.closest('[data-toggle]');
      if (toggle) {
        const line = lines.find((entry) => entry.id === toggle.dataset.toggle); if (!line) return;
        line.on = !line.on;
        const card = toggle.closest('.gxd-line');
        card.dataset.on = String(line.on); toggle.setAttribute('aria-checked', String(line.on));
        toggle.title = line.on ? t('prices_line_on', 'On your proposals') : t('prices_line_off', 'Not on your proposals');
        report(); return;
      }
      const edit = event.target.closest('[data-edit]');
      if (edit) {
        const line = lines.find((entry) => entry.id === edit.dataset.edit); if (!line) return;
        editor = { stage: 'new', editing: line.id, name: line.name, active: 0, unit: line.unit, price: line.price, terms: line.terms.map((term) => ({ ...term })), waste: !!line.waste };
        draw('[data-new-name]'); return;
      }
      if (event.target.closest('[data-add]')) { editor = { stage: 'name', name: '', active: 0, unit: 'ea', price: '', terms: [{ factor: 1, key: '' }], waste: false }; draw('[data-new-name]'); return; }
      if (event.target.closest('[data-cancel]')) { const was = editor?.editing; editor = null; draw(was ? `[data-edit="${CSS.escape(was)}"]` : '[data-add]'); return; }
      const pick = event.target.closest('[data-pick]');
      if (pick) { if (pick.dataset.pick) addFromBook(pick.dataset.pick); else { editor.stage = 'new'; draw('[data-new-price]'); } return; }
      if (event.target.closest('[data-add-term]')) { editor.terms.push({ factor: 1, key: array(sheet.measurements)[0]?.key || '' }); draw(`[data-factor="${editor.terms.length - 1}"]`); return; }
      const drop = event.target.closest('[data-drop-term]');
      if (drop) { editor.terms.splice(Number(drop.dataset.dropTerm), 1); draw(); return; }
      if (event.target.closest('[data-save-new]')) saveNew();
    };
    const onInput = (event) => {
      const target = event.target;
      if (target.matches('[data-price]')) { const line = lines.find((entry) => entry.id === target.dataset.price); if (line) { line.price = target.value; report(); } return; }
      if (!editor) return;
      if (target.matches('[data-new-name]')) { editor.name = target.value; editor.active = 0; if (editor.stage === 'name') drawSuggestions(); return; }
      if (target.matches('[data-new-price]')) { editor.price = target.value; return; }
      if (target.matches('[data-factor]')) { editor.terms[Number(target.dataset.factor)].factor = target.value; return; }
    };
    const onChange = (event) => {
      const target = event.target;
      if (!editor) return;
      if (target.matches('[data-new-unit]')) {
        editor.unit = target.value;
        // A measurement in the same unit is the likely amount: squares for a line sold per square, and so on.
        const first = editor.terms[0];
        if (editor.terms.length === 1 && first.key === '' && editor.unit !== 'ea') first.key = array(sheet.measurements).find((field) => editor.unit === 'sq' ? /Squares/.test(field.key) : /Lf$/.test(field.key))?.key || '';
        draw('[data-new-unit]'); return;
      }
      if (target.matches('[data-measure]')) {
        editor.terms[Number(target.dataset.measure)].key = target.value;
        // Picking a measurement says the unit when it is still the default.
        if (editor.terms.length === 1 && editor.unit === 'ea' && target.value) editor.unit = /Squares$/.test(target.value) ? 'sq' : /Lf$/.test(target.value) ? 'lf' : 'ea';
        draw(`[data-measure="${target.dataset.measure}"]`); return;
      }
      if (target.matches('[data-new-waste]')) editor.waste = target.checked;
    };
    const onKey = (event) => {
      if (!editor || !event.target.matches?.('[data-new-name]') || editor.stage !== 'name') return;
      const count = suggestions(editor.name).length + 1;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); editor.active = (editor.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count; drawSuggestions(); }
      else if (event.key === 'Enter' && clean(editor.name)) { event.preventDefault(); el.querySelectorAll('[data-pick]')[editor.active]?.click(); }
    };
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', onKey);
    // Files dropped on the estimates page are added as if chosen.
    const onDrag = (event) => {
      if (phase !== 'uploads' || ![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      el.querySelector('[data-add-estimates]')?.classList.toggle('gxd-dragging', event.type === 'dragover');
      if (event.type === 'drop') addEstimates([...(event.dataTransfer.files || [])]);
    };
    ['dragover', 'dragleave', 'drop'].forEach((name) => el.addEventListener(name, onDrag));

    ctx.read('document-setup', 'price_sheet').then((value) => {
      if (!alive) return;
      sheet = { editable: false, catalog: [], measurements: [], ...object(value) };
      const items = array(sheet.items).map((item) => ({ ...item, unit_price: item.unit_price == null ? null : Number(item.unit_price) }));
      if (!items.length && !sheet.editable) {
        el.innerHTML = `<div class="gxd"><p>${esc(t('prices_none', 'Your price book has nothing for these yet. Skip this step and set your prices in the price book any time.'))}</p></div>`;
        return;
      }
      // Back from a later step (or the setup played again): the lines as they were left, new ones included. A new line
      // a finish already wrote is in the price book now, by its name: it is that item.
      const byName = new Map([...items, ...array(sheet.catalog)].map((item) => [clean(item.name).toLowerCase(), item]));
      const written = new Map(array(givenLines?.new_items).filter((entry) => byName.has(clean(entry.name).toLowerCase())).map((entry) => [entry.key, byName.get(clean(entry.name).toLowerCase())]));
      const on = givenLines ? new Set(array(givenLines.on).map((id) => written.get(id)?.id || id)) : null;
      lines = items.map((item) => lineFrom(item, on ? on.has(item.id) : item.on !== false));
      if (givenLines) {
        for (const id of on) {
          const item = array(sheet.catalog).find((entry) => entry.id === id);
          if (item && !lines.some((line) => line.id === id)) lines.push(lineFrom(item, true));
        }
        for (const entry of array(givenLines.new_items)) {
          const item = written.get(entry.key);
          if (item) { const line = lines.find((candidate) => candidate.id === item.id); if (line && entry.unit_price !== line.book) line.price = priceText(entry.unit_price); continue; }
          lines.push({ id: entry.key, name: entry.name, unit: entry.unit, category: '', book: null, price: priceText(entry.unit_price), on: true, isNew: true, initial: false, terms: termsOf(array(entry.formula)) || [{ factor: 1, key: '' }], waste: !!entry.include_waste, formula: '' });
        }
      }
      phase = givenLines || given.size ? 'list' : 'start';
      draw();
      if (phase === 'list') report();
    }).catch((error) => { if (alive) el.innerHTML = `<div class="gxd"><p class="gxd-error" role="alert">${esc(clean(error?.message) || t('load_failed', 'This didn’t load. Skip this step or try again.'))}</p></div>`; });
    return {
      valid: () => true,
      summary: () => summaryText(),
      // Escape closes the line being added first.
      escape: () => { if (!editor) return false; editor = null; draw('[data-add]'); return true; },
      // The estimates page is a page of the step's own (GP-51): its Back and Continue, and the phone's back, lead out of it.
      get handlesNavigation(){ return phase === 'uploads'; },
      backDepth: () => phase === 'uploads' ? 1 : 0,
      back: () => { if (phase !== 'uploads') return false; leaveUploads(uploadsFrom); return true; },
      destroy(){
        alive = false;
        if (!wasWide) sheetEl?.classList.remove('gxs-wide');
        if (!wasFill) pane?.removeAttribute('data-fill');
        el.removeEventListener('click', onClick); el.removeEventListener('input', onInput); el.removeEventListener('change', onChange); el.removeEventListener('keydown', onKey);
        ['dragover', 'dragleave', 'drop'].forEach((name) => el.removeEventListener(name, onDrag));
      }
    };
  }

  // ── Which kinds of proposals (GP-55) ──────────────────────────────────
  // Only for a company that does insurance work (company.services `storm_insurance`, asked just before when it was not
  // yet): retail proposals, insurance contingency agreements, or both, as many as apply. Any other company goes on
  // without seeing it (retail), and Back from the next step passes it the other way.
  function kindsPart(){
    let alive = true, picked = null, timer = 0;
    const pane = el.closest('.gxs-step');
    const hide = (hidden) => { if (pane) pane.style.visibility = hidden ? 'hidden' : ''; };
    const mountedAt = Date.now();
    const handle = {
      valid: () => !!picked?.size,
      hint: () => t('proposal_kinds_hint', 'Choose at least one.'),
      summary: () => picked?.size ? [...picked].map((id) => L(choices.find((choice) => choice.id === id).title)).join(', ') : '',
      // A pane passed is left hidden as it goes: each step gets a pane of its own.
      destroy(){ alive = false; clearTimeout(timer); el.removeEventListener('click', onClick); }
    };
    const choices = [
      { id: 'retail', icon: 'fa-file-signature', title: ['gx_docs_setup_proposal_kinds_retail', 'Retail proposals'], hint: ['gx_docs_setup_proposal_kinds_retail_hint', 'You price the job and the homeowner pays you.'] },
      { id: 'insurance', icon: 'fa-house-crack', title: ['gx_docs_setup_proposal_kinds_insurance', 'Insurance agreements'], hint: ['gx_docs_setup_proposal_kinds_insurance_hint', 'A contingency agreement: the homeowner signs that you do the work their insurance approves, for what it approves.'] }
    ];
    const report = () => {
      const value = picked.has('retail') && picked.has('insurance') ? 'both' : picked.has('insurance') ? 'insurance' : picked.has('retail') ? 'retail' : undefined;
      ctx.change({ proposal_kinds: value }, handle.summary());
    };
    function onClick(event){
      const tile = event.target.closest('[data-kind]'); if (!tile || !picked) return;
      const id = tile.dataset.kind;
      if (picked.has(id)) picked.delete(id); else picked.add(id);
      tile.setAttribute('aria-checked', String(picked.has(id)));
      report();
    }
    el.addEventListener('click', onClick);
    function show(){
      const before = clean(selections.proposal_kinds);
      picked = new Set(before === 'both' ? ['retail', 'insurance'] : before === 'insurance' ? ['insurance'] : before === 'retail' ? ['retail'] : []);
      el.innerHTML = `<div class="gxd"><div class="gxs-choices" style="--gxs-n:2" role="group" aria-label="${esc(ctx.L(ctx.step.title))}">${choices.map((choice) => `
        <button type="button" class="gxd-tile gxs-choice" role="checkbox" data-kind="${esc(choice.id)}" aria-checked="${picked.has(choice.id)}">
          <span class="gxd-icon gxs-choice-icon" aria-hidden="true"><i class="fas ${esc(choice.icon)}"></i></span>
          <span class="gxs-choice-text"><strong>${esc(L(choice.title))}</strong><small>${esc(L(choice.hint))}</small></span>${choiceTick}
        </button>`).join('')}</div>
        <p class="gxd-note gxd-note-center">${esc(t('proposal_kinds_note', 'Select both if you do both.'))}</p></div>`;
      hide(false);
      if (picked.size) report();
    }
    // Back to here after going on without it: on to the step before (once; then it is asked as it would be).
    if (passedKinds.has(selections)) {
      passedKinds.delete(selections);
      hide(true);
      ctx.back?.();
      timer = setTimeout(() => { if (alive) show(); }, 700);
      return handle;
    }
    hide(true);
    el.innerHTML = '<div class="gxd"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
    ctx.read('company-profile', 'profile').then((profile) => {
      if (!alive) return;
      const services = array(object(profile).services).map((entry) => clean(entry?.id ?? entry));
      if (services.includes('storm_insurance')) { show(); return; }
      // No insurance work: retail, and on (after the press that brought it here has settled: the player counts a second
      // press within a moment as the same one).
      picked = new Set(['retail']);
      ctx.change({ proposal_kinds: 'retail' }, '');
      passedKinds.add(selections);
      timer = setTimeout(() => { if (alive) ctx.advance?.(); }, Math.max(0, 320 - (Date.now() - mountedAt)));
    }).catch(() => { if (alive) show(); });
    return handle;
  }

  // ── Three styles, previewed with what the answers make ────────────────
  function stylePart(){
    let alive = true, previews = [], Renderer = null, timer = 0, lastSize = '', center = 0, drag = null, dragged = false, view = null;
    const cards = [];
    // Both kinds of proposals: the retail proposal's previews; the style chosen is the insurance agreement's too.
    const args = answersOf(selections);
    // The previews want room: the sheet widens (the player's wide sheet) and this step fills it. The sheet's Back and
    // Done float over its bottom edge (data-float-foot), beside the style's name, so the carousel has the full height.
    const sheet = el.closest('.gxs'), wasWide = !!sheet?.classList.contains('gxs-wide');
    sheet?.classList.add('gxs-wide');
    const pane = el.closest('.gxs-step');
    pane?.setAttribute('data-fill', '');
    pane?.setAttribute('data-float-foot', '');
    // Filled, the step does not scroll by itself; on a short window the carousel keeps a least size and the step scrolls.
    if (pane) { pane.style.overflowY = 'auto'; pane.style.paddingBottom = '14px'; }
    el.innerHTML = '<div class="gxd"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
    const PAGE_W = 612 * 96 / 72, PAGE_H = 792 * 96 / 72, SIDE = 0.62, INSET = 16;
    let step = 1;
    const chosen = () => previews[center]?.theme_id || '';
    // The style in the middle is the one chosen.
    const report = () => { const entry = previews[center]; if (entry) styled.add(selections); ctx.change(entry ? { theme_id: entry.theme_id } : {}, entry ? entry.name : ''); };
    /** Where each card sits: -1 left, 0 middle, 1 right (and further out with more styles), going round. */
    const offsetOf = (at) => { const n = previews.length; let d = ((at - center) % n + n) % n; if (d > n / 2) d -= n; return d; };
    /** A card at a position (fractional while dragged): along the row, shrinking from the middle to a side card's size. */
    const pose = (at) => `translateX(${at * step}px) scale(${1 - (1 - SIDE) * Math.min(1, Math.abs(at))})`;
    function layout(before){
      const stage = el.querySelector('.gxd-stage'); if (!stage) return;
      const wide = stage.clientWidth, high = Math.max(160, stage.clientHeight - INSET * 2);
      const phone = wide < 640;
      const width = Math.max(200, Math.min(wide * (phone ? 0.72 : 0.46), high * PAGE_W / PAGE_H));
      // Room between the middle page and the ones beside it (FM-608: they were crowded).
      step = width / 2 + (phone ? 18 : Math.max(44, width * 0.1)) + width * SIDE / 2;
      cards.forEach((card, at) => {
        const offset = offsetOf(at), was = before ? before[at] : offset;
        const side = offset !== 0;
        Object.assign(card.el.style, { top: `${INSET}px`, width: `${width}px`, height: `${high}px`, marginLeft: `${-width / 2}px`, zIndex: String(10 - Math.abs(offset)), visibility: Math.abs(offset) > 1 ? 'hidden' : '' });
        // A card going round the back (one end to the other) leaves past its old side and comes in from beyond its new
        // one, instead of crossing the middle or appearing where it lands (FM-608).
        if (Math.abs(offset - was) > 1) {
          if (Math.abs(was) <= 1 && was !== 0) leave(card, was);
          if (Math.abs(offset) <= 1 && offset !== 0) {
            card.el.classList.add('gxd-jump');
            card.el.style.transform = pose(offset + Math.sign(offset)); card.el.style.opacity = '0';
            void card.el.offsetWidth;
            card.el.classList.remove('gxd-jump');
          }
        }
        card.el.style.transform = pose(offset); card.el.style.opacity = '';
        card.el.dataset.role = side ? 'side' : 'center';
        card.el.setAttribute('aria-hidden', String(side));
        card.el.tabIndex = side ? -1 : 0;
        card.el.querySelector('.gxd-expand').tabIndex = side ? -1 : 0;
        if (side) card.doc.scrollTop = 0;
        if (card.width !== width) draw(card, width);
      });
      const entry = previews[center];
      const caption = el.querySelector('[data-caption]');
      if (caption && entry) caption.innerHTML = `<strong>${esc(entry.name)}</strong><small>${esc(entry.description)}</small>`;
      el.querySelectorAll('[data-dot]').forEach((dot) => dot.setAttribute('aria-current', String(Number(dot.dataset.dot) === center)));
    }
    /** A copy of a card that slides on out past the side it was on and fades, while the card itself comes round. */
    function leave(card, was){
      const ghost = card.el.cloneNode(true);
      ghost.classList.add('gxd-ghost'); ghost.removeAttribute('role'); ghost.setAttribute('aria-hidden', 'true'); ghost.style.zIndex = '1';
      card.el.after(ghost);
      void ghost.offsetWidth;
      ghost.style.transform = pose(was + Math.sign(was)); ghost.style.opacity = '0';
      setTimeout(() => ghost.remove(), 500);
    }
    /** A card's document: every page of the real render at the middle card's width (the sides are the same, scaled down). */
    function draw(card, width){
      if (!Renderer) return;
      card.width = width;
      try { card.handle?.destroy?.(); } catch (_) {}
      card.handle = render(card.doc, card.preview, width);
    }
    function render(host, preview, width){
      host.innerHTML = '<div></div>';
      try {
        return Renderer.render(host.firstElementChild, { document: preview.resolved_definition, theme: preview.theme, themeContext: { overrides: object(preview.theme_vars) }, widgetData: object(preview.widget_data), mode: 'static', scale: width / PAGE_W });
      } catch (error) { host.textContent = clean(error?.message); return null; }
    }
    function go(to){
      if (!previews.length) return;
      const before = cards.map((_, at) => offsetOf(at));
      center = ((to % previews.length) + previews.length) % previews.length;
      layout(before);
      report();
      if (view) showView();
    }

    // ── The style in the middle, full screen ──
    function showView(){
      const entry = previews[center]; if (!entry) return;
      const width = Math.min(window.innerWidth - (window.innerWidth < 640 ? 24 : 160), 960);
      if (!view) {
        view = document.createElement('div');
        view.className = 'gxd-view'; view.setAttribute('role', 'dialog'); view.setAttribute('aria-modal', 'true');
        view.innerHTML = `<div class="gxd-view-bar"><div data-view-caption></div><button type="button" class="gxd-view-close" data-view-close aria-label="${esc(t('style_view_close', 'Close'))}">&times;</button></div>
          <div class="gxd-view-scroll"><div class="gxd-view-doc"></div></div>
          ${previews.length > 1 ? `<button type="button" class="gxd-arrow" data-view-go="-1" aria-label="${esc(t('style_previous', 'Previous style'))}">‹</button><button type="button" class="gxd-arrow" data-view-go="1" aria-label="${esc(t('style_next', 'Next style'))}">›</button>` : ''}`;
        view.addEventListener('click', onViewClick);
        view.addEventListener('keydown', onViewKey);
        (el.closest('.gxs') || document.body).append(view);
        view.querySelector('[data-view-close]').focus({ preventScroll: true });
      }
      view.setAttribute('aria-label', entry.name);
      view.querySelector('[data-view-caption]').innerHTML = `<strong>${esc(entry.name)}</strong><small>${esc(entry.description)}</small>`;
      const doc = view.querySelector('.gxd-view-doc');
      doc.style.width = `${width}px`;
      try { view.handle?.destroy?.(); } catch (_) {}
      view.handle = render(doc, entry, width);
      view.querySelector('.gxd-view-scroll').scrollTop = 0;
    }
    function closeView(){
      if (!view) return false;
      try { view.handle?.destroy?.(); } catch (_) {}
      view.remove(); view = null;
      cards[center]?.el.querySelector('.gxd-expand')?.focus({ preventScroll: true });
      return true;
    }
    const onViewClick = (event) => {
      if (event.target.closest('[data-view-close]')) { closeView(); return; }
      const arrow = event.target.closest('[data-view-go]'); if (arrow) go(center + Number(arrow.dataset.viewGo));
    };
    const onViewKey = (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); go(center - 1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); go(center + 1); }
    };

    const onClick = (event) => {
      // The click that ends a drag is not a press on what it ended over.
      if (dragged) { dragged = false; return; }
      if (event.target.closest('[data-expand]')) { showView(); return; }
      const arrow = event.target.closest('[data-go]'); if (arrow) { go(center + Number(arrow.dataset.go)); return; }
      const dot = event.target.closest('[data-dot]'); if (dot) { go(Number(dot.dataset.dot)); return; }
      const card = event.target.closest('.gxd-card'); if (!card) return;
      const at = cards.findIndex((entry) => entry.el === card);
      if (at >= 0 && at !== center) go(at);
    };
    const onDoubleClick = (event) => { const card = event.target.closest('.gxd-card'); if (card && card === cards[center]?.el) showView(); };
    const onKey = (event) => {
      if (event.target.closest?.('input,textarea')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); go(center - 1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); go(center + 1); }
    };
    // Dragging sideways (a mouse or a finger) moves the cards with it and turns the carousel when let go far or fast
    // enough; up and down scroll the document in the middle, and its scroll bar is not a drag.
    const onPointerDown = (event) => {
      dragged = false;
      if (drag || previews.length < 2 || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if (event.target.closest('button,a,input,textarea,select')) return;
      const doc = event.target.closest('.gxd-doc');
      if (doc && event.target === doc && event.offsetX >= doc.clientWidth) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, moving: false, samples: [] };
    };
    const onPointerMove = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moving) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
        if (Math.abs(dx) < 8) return;
        drag.moving = true;
        const stage = el.querySelector('.gxd-stage');
        try { stage.setPointerCapture(event.pointerId); } catch (_) {}
        stage.classList.add('gxd-dragging');
        window.getSelection?.()?.removeAllRanges?.();
      }
      event.preventDefault();
      drag.dx = dx;
      drag.samples.push([event.timeStamp, dx]); if (drag.samples.length > 6) drag.samples.shift();
      cards.forEach((card, at) => {
        const offset = offsetOf(at);
        if (Math.abs(offset) <= 1) card.el.style.transform = pose(offset + dx / step);
      });
    };
    const endDrag = (event, cancelled) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { moving, dx, samples } = drag; drag = null;
      if (!moving) return;
      dragged = !cancelled;
      el.querySelector('.gxd-stage')?.classList.remove('gxd-dragging');
      const [first, last] = [samples[0], samples[samples.length - 1]];
      const speed = first && last && last[0] > first[0] ? (last[1] - first[1]) / (last[0] - first[0]) : 0;
      let turn = Math.round(-dx / step);
      if (!turn && !cancelled && (Math.abs(dx) > Math.min(90, step * 0.22) || (Math.abs(speed) > 0.45 && Math.sign(speed) === Math.sign(dx)))) turn = dx < 0 ? 1 : -1;
      if (turn && !cancelled) go(center + turn); else layout();
      // A drag that ends outside the step leaves no click to swallow.
      setTimeout(() => { dragged = false; }, 400);
    };
    const onPointerUp = (event) => endDrag(event, false);
    const onPointerCancel = (event) => endDrag(event, true);
    const onDragStart = (event) => event.preventDefault();
    el.addEventListener('click', onClick);
    el.addEventListener('dblclick', onDoubleClick);
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('dragstart', onDragStart);
    // Laid out again when the carousel changes size (the sheet widening, the window resized), once it has settled.
    const observer = window.ResizeObserver ? new ResizeObserver(() => {
      const stage = el.querySelector('.gxd-stage'); const size = stage ? `${stage.clientWidth}x${stage.clientHeight}` : '';
      if (!size || size === lastSize) return;
      lastSize = size; clearTimeout(timer); timer = setTimeout(() => { if (alive) { layout(); if (view) showView(); } }, 160);
    }) : null;
    Promise.all([ctx.read('document-setup', 'previews', { args }), renderer()]).then(([value, loaded]) => {
      if (!alive) return;
      Renderer = loaded;
      previews = array(object(value).previews);
      const start = styled.has(selections) ? clean(selections.theme_id) : clean(object(value).theme_id) || clean(selections.theme_id);
      center = Math.max(0, previews.findIndex((preview) => preview.theme_id === start));
      el.innerHTML = `<div class="gxd gxd-fill">
        <div class="gxd-stage" tabindex="0" role="listbox" aria-label="${esc(ctx.L(ctx.step.title))}">
          ${previews.map((preview) => `<div class="gxd-card" role="option" data-theme="${esc(preview.theme_id)}" aria-label="${esc(preview.name)}"><div class="gxd-doc"></div><button type="button" class="gxd-expand" data-expand aria-label="${esc(t('style_view', 'See it full screen'))}" title="${esc(t('style_view', 'See it full screen'))}"><i class="fas fa-expand" aria-hidden="true"></i></button></div>`).join('')}
          <button type="button" class="gxd-arrow" data-go="-1" aria-label="${esc(t('style_previous', 'Previous style'))}">‹</button>
          <button type="button" class="gxd-arrow" data-go="1" aria-label="${esc(t('style_next', 'Next style'))}">›</button>
        </div>
        <div class="gxd-under">
          <div class="gxd-caption" data-caption aria-live="polite"></div>
          <div class="gxd-dots">${previews.map((preview, at) => `<button type="button" data-dot="${at}" aria-label="${esc(preview.name)}"></button>`).join('')}</div>
        </div>
      </div>`;
      el.querySelectorAll('.gxd-card').forEach((node, at) => cards.push({ el: node, doc: node.querySelector('.gxd-doc'), preview: previews[at], handle: null, width: 0 }));
      const stage = el.querySelector('.gxd-stage');
      lastSize = `${stage.clientWidth}x${stage.clientHeight}`;
      layout();
      observer?.observe(stage);
      report();
    }).catch((error) => { if (alive) el.innerHTML = `<div class="gxd"><p class="gxd-error" role="alert">${esc(clean(error?.message) || t('preview_failed', 'The previews didn’t load. Close the setup and try again.'))}</p></div>`; });
    return {
      valid: () => !!chosen(),
      hint: () => t('style_hint', 'Choose a style.'),
      summary: () => previews[center]?.name || '',
      // Escape (and a phone's back) closes the full-screen view first.
      escape: () => closeView(),
      destroy(){
        // The style chosen goes on with the setup, to the right of its wording (FM-614).
        if (cards[center]) keepDocument(cards[center].doc);
        alive = false; clearTimeout(timer); observer?.disconnect(); closeView();
        if (!wasWide) sheet?.classList.remove('gxs-wide');
        el.removeEventListener('click', onClick); el.removeEventListener('dblclick', onDoubleClick); el.removeEventListener('keydown', onKey);
        el.removeEventListener('pointerdown', onPointerDown); el.removeEventListener('pointermove', onPointerMove);
        el.removeEventListener('pointerup', onPointerUp); el.removeEventListener('pointercancel', onPointerCancel); el.removeEventListener('dragstart', onDragStart);
        cards.forEach((card) => { try { card.handle?.destroy?.(); } catch (_) {} });
      }
    };
  }

  // ── The template's wording, beside the document (FM-614) ──────────────
  // The fields are the template's own copy, top to bottom (document-setup.copy): its title, its opening, its headings
  // and what is under them. What is changed is the setup's `copy` and goes into the template when it is saved. Advanced
  // saves the template and opens it in the template editor; what is published there is kept (`keep_edits`).
  /** Whether the template editor would open here: the runtime's own access check, as its mount makes it. */
  function studioAvailable(){
    const runtime = window.FirstMateEmbeddableApps;
    if (!runtime?.mount || !runtime.evaluateAccess) return false;
    try {
      const app = runtime.getApp?.('documents.studio') || { id: 'documents.studio', portalTabId: 'documents_studio', surfaces: ['portal_tab'] };
      return runtime.evaluateAccess(app, { orgId: ctx.orgId, surface: 'portal_tab', active: true }).allowed === true;
    } catch (_) { return false; }
  }
  function copyPart(){
    let alive = true, data = null, Renderer = null, handle = null, timer = 0, studio = null, opening = false;
    // The insurance agreement's own page, for a company that makes both kinds of proposals (GP-55): its wording is kept
    // apart. With insurance agreements only, the one wording page is the agreement's and its wording is `copy`.
    const insurance = clean(ctx.options.target) === 'insurance';
    const copyKey = insurance ? 'insurance_copy' : 'copy', keepKey = insurance ? 'insurance_keep_edits' : 'keep_edits';
    const sectionsKey = insurance ? 'insurance_copy_sections' : 'copy_sections';
    const edits = { ...object(selections[copyKey]) };
    // Parts of the wording taken out and added (GP-97); the last deletion can be undone until the next change.
    const sections = sectionChanges(selections[sectionsKey]);
    let active = '', undo = null;
    let keepEdits = selections[keepKey] === true;
    const sheet = el.closest('.gxs'), wasWide = !!sheet?.classList.contains('gxs-wide');
    sheet?.classList.add('gxs-wide');
    const pane = el.closest('.gxs-step');
    pane?.setAttribute('data-fill', '');
    el.innerHTML = `<div class="gxd gxd-fill gxd-copy-step"><div class="gxd-copy">
      <nav class="gxd-copy-nav" aria-label="${esc(t('copy_sections', 'Sections'))}"></nav>
      <div class="gxd-copy-fields"><div class="gxd-copy-edit"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div><button type="button" class="gxd-copy-more" data-copy-more hidden></button></div>
      <div class="gxd-copy-view"><div class="gxd-doc"></div></div>
    </div><p class="gxd-error" role="alert"></p></div>`;
    const nav = el.querySelector('.gxd-copy-nav'), fieldsHost = el.querySelector('.gxd-copy-edit'), more = el.querySelector('[data-copy-more]'), view = el.querySelector('.gxd-copy-view'), docHost = view.querySelector('.gxd-doc'), error = el.querySelector('.gxd-error');
    // The style chosen slides over to the right; it stays there until its document has been drawn in this step. The
    // insurance agreement's page shows another document: nothing is carried to it.
    const lifted = insurance ? (handoff = null) : liftDocument(sheet || document.body);
    glide(lifted, view);
    // Advanced, a link beside the step's title: only where the template editor would open (GP-13). An organization
    // without it (or a phone, where it is not offered) never sees a button that can only fail.
    const advanced = studioAvailable() ? document.createElement('button') : null;
    if (advanced) {
      advanced.type = 'button'; advanced.className = 'gxd-studio-link'; advanced.dataset.advanced = '';
      advanced.innerHTML = `<i class="fas fa-pen-ruler" aria-hidden="true"></i>${esc(t('copy_advanced', 'Advanced'))}`;
      advanced.title = t('copy_advanced_hint', 'Open your template in the full template editor');
      ctx.actions?.append(advanced);
    }
    const answers = () => ({ ...answersOf(selections), theme_id: clean(selections.theme_id), ...(insurance ? { agreement: 'insurance' } : {}) });
    /** Each part added and each removed is a change, and so is each wording changed (an added part's own wording is part of it). */
    const changeCount = () => {
      const own = new Set(sections.added.flatMap((add) => [`${add.id}_h`, `${add.id}_t`]));
      return Object.keys(edits).filter((id) => !own.has(id)).length + sections.removed.length + sections.added.length;
    };
    const summary = () => { const count = changeCount(); return count ? t('copy_summary', '{count} changes').replace('{count}', String(count)) : ''; };
    const report = () => {
      ctx.change({ [copyKey]: { ...edits }, [sectionsKey]: sectionChanges(sections), [keepKey]: keepEdits }, summary() || (keepEdits ? t('copy_summary_edited', 'Edited in the template editor') : ''));
    };
    function draw(){
      if (!data || !Renderer) return;
      const width = Math.max(200, Math.min(docHost.clientWidth - 28, 760));
      const preview = data.preview;
      const definition = applyCopy(JSON.parse(JSON.stringify(preview.resolved_definition)), edits, sections, array(data.sections));
      const keep = docHost.scrollTop;
      try { handle?.destroy?.(); } catch (_) {}
      docHost.innerHTML = '<div></div>';
      try {
        handle = Renderer.render(docHost.firstElementChild, { document: definition, theme: preview.theme, themeContext: { overrides: object(preview.theme_vars) }, widgetData: object(preview.widget_data), mode: 'static', scale: width / (612 * 96 / 72) });
      } catch (failure) { docHost.textContent = clean(failure?.message); }
      docHost.scrollTop = keep;
    }
    const redraw = () => { clearTimeout(timer); timer = setTimeout(() => { if (alive) draw(); }, 180); };
    /** The text a field is about, in the document: scrolled to and marked while the field has focus. */
    function mark(id){
      docHost.querySelectorAll('.gxd-copy-mark').forEach((node) => node.classList.remove('gxd-copy-mark'));
      const node = id ? docHost.querySelector(`[data-node-id="${CSS.escape(id)}"]`) : null;
      if (!node) return;
      node.classList.add('gxd-copy-mark');
      const top = node.getBoundingClientRect().top - docHost.getBoundingClientRect().top + docHost.scrollTop;
      docHost.scrollTo({ top: Math.max(0, top - 60), behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    const grow = (area) => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight + 2}px`; };
    /** Each copy node's words in the template, before any change. */
    let known = null;
    const originals = () => known || (known = new Map(array(data?.fields).map((field) => [field.node_id, field.text])));
    const valueOf = (id) => edits[id] ?? originals().get(id) ?? '';
    /**
     * The parts of the wording as they are now (GP-97): the template's (document-setup.copy `sections`), less those
     * removed, with those added each straight after the part it was added after, as applyCopy puts them in the document.
     */
    function ordered(){
      const list = array(data?.sections).map((part) => ({ ...part }));
      for (const add of sections.added) {
        const at = list.findIndex((part) => part.id === add.after);
        if (at >= 0) list.splice(at + 1, 0, { id: add.id, heading: `${add.id}_h`, texts: [`${add.id}_t`], nodes: [], removable: true, added: true });
      }
      return list.filter((part) => !sections.removed.includes(part.id));
    }
    /** What a part is called in the list: its heading's words, else what it is or how its text starts. */
    function partName(part, opening){
      const heading = clean(part.heading ? valueOf(part.heading) : '').replace(/\s+/g, ' ');
      if (heading) return heading;
      if (part.title) return t('copy_title', 'Title');
      if (part.added) return t('copy_new_section', 'New section');
      if (opening) return t('copy_opening', 'Opening');
      return clean(valueOf(array(part.texts)[0])).replace(/\s+/g, ' ') || t('copy_text', 'Text');
    }
    /** Which parts are the opening: copy before the first heading that is not the title (GP-18's "Opening"). */
    function openings(list){
      const found = new Set();
      for (const part of list) { if (part.heading && !part.title) break; if (!part.heading || part.title) { found.add(part.id); if (array(part.texts).length) break; } }
      return found;
    }
    function fields(){
      const list = ordered();
      if (!list.length) return `<p>${esc(advanced ? t('copy_none', 'This document has no wording of its own to change here. Advanced opens it in the template editor.') : t('copy_none_plain', 'This document has no wording of its own to change here.'))}</p>`;
      const value = (id) => esc(valueOf(id));
      const input = (id, cls = '', label = '', placeholder = '') => `<input type="text" data-copy="${esc(id)}" class="${cls}" value="${value(id)}"${label ? ` aria-label="${esc(label)}"` : ''}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}>`;
      const area = (id, label = '', placeholder = '') => `<textarea data-copy="${esc(id)}" rows="2"${label ? ` aria-label="${esc(label)}"` : ''}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}>${value(id)}</textarea>`;
      // Part by part, top to bottom, each field named for what it is (GP-18): "Title", "Opening", then each heading by its
      // own words ("Approval heading") with the text under it. A part added has a heading and a paragraph.
      let html = '', opened = false;
      for (const part of list) {
        html += `<section class="gxd-copy-sec${part.added ? ' gxd-copy-new' : ''}" data-sec="${esc(part.id)}">`;
        if (part.added) {
          html += `<label class="gxd-copy-heading">${esc(t('copy_heading', 'Heading'))}${input(part.heading, '', '', t('copy_new_heading', 'Heading'))}</label>`;
          html += area(part.texts[0], t('copy_text', 'Text'), t('copy_new_text', 'What this section says'));
        } else {
          if (part.title) html += `<label>${esc(t('copy_title', 'Title'))}${input(part.heading, 'gxd-copy-title')}</label>`;
          else if (part.heading) {
            const name = t('copy_heading_named', '{name} heading').replace('{name}', headingName(originals().get(part.heading)));
            html += `<label class="gxd-copy-heading">${esc(name)}${input(part.heading)}</label>`; opened = true;
          }
          for (const id of array(part.texts)) {
            if (!opened) { html += `<label>${esc(t('copy_opening', 'Opening'))}${area(id)}</label>`; opened = true; }
            else html += area(id, t('copy_text', 'Text'));
          }
        }
        html += '</section>';
      }
      return html;
    }
    /** The list of parts down the left (GP-97): go to one, add one after it, delete it; add one at the end. */
    function showNav(){
      if (!data) { nav.innerHTML = ''; return; }
      const list = ordered(), opening = openings(list);
      if (!list.length) { nav.innerHTML = ''; return; }
      if (!list.some((part) => part.id === active)) active = '';
      nav.innerHTML = `<ol>${list.map((part) => {
        const name = partName(part, opening.has(part.id));
        return `<li class="gxd-copy-nav-item${part.id === active ? ' gxd-on' : ''}" data-sec="${esc(part.id)}">
          <button type="button" class="gxd-copy-nav-go" data-sec-go title="${esc(name)}">${esc(name)}</button>
          <span class="gxd-copy-nav-tools">
            <button type="button" data-sec-add-after aria-label="${esc(t('copy_section_add_after', 'Add a section below'))}" title="${esc(t('copy_section_add_after', 'Add a section below'))}"><i class="fas fa-plus" aria-hidden="true"></i></button>
            ${part.removable ? `<button type="button" data-sec-delete aria-label="${esc(t('copy_section_delete', 'Delete this section'))}" title="${esc(t('copy_section_delete', 'Delete this section'))}"><i class="fas fa-trash-can" aria-hidden="true"></i></button>` : ''}
          </span></li>`;
      }).join('')}</ol>
      <button type="button" class="gxd-copy-add" data-sec-add><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('copy_section_add', 'Add section'))}</button>
      ${undo ? `<button type="button" class="gxd-copy-undo" data-sec-undo><i class="fas fa-rotate-left" aria-hidden="true"></i>${esc(t('copy_section_undo', 'Undo delete'))}</button>` : ''}`;
    }
    function setActive(id){
      if (id === active) return;
      active = id;
      nav.querySelectorAll('.gxd-copy-nav-item').forEach((item) => item.classList.toggle('gxd-on', item.dataset.sec === id));
    }
    /** The part being read: the one with focus, else the first one showing at the top of the column. */
    function spy(){
      if (!alive || fieldsHost.contains(document.activeElement)) return;
      const top = fieldsHost.getBoundingClientRect().top + 12;
      const part = [...fieldsHost.querySelectorAll('.gxd-copy-sec')].find((node) => node.getBoundingClientRect().bottom > top);
      if (part) setActive(part.dataset.sec);
    }
    function showFields(){
      known = null;
      const keep = fieldsHost.scrollTop;
      fieldsHost.innerHTML = `${keepEdits ? `<p class="gxd-copy-edited"><i class="fas fa-circle-check" aria-hidden="true"></i> ${esc(t('copy_edited', 'Your changes from the template editor are kept.'))}</p>` : ''}
        ${fields()}`;
      fieldsHost.querySelectorAll('textarea').forEach(grow);
      fieldsHost.scrollTop = keep;
      showNav();
      below();
    }
    /** A part's first field, scrolled to the top of the column and given focus (its words selected when it was just added). */
    function goTo(id, select = false){
      const part = fieldsHost.querySelector(`.gxd-copy-sec[data-sec="${CSS.escape(id)}"]`);
      if (!part) return;
      const top = part.getBoundingClientRect().top - fieldsHost.getBoundingClientRect().top + fieldsHost.scrollTop;
      fieldsHost.scrollTo({ top: Math.max(0, top - 8), behavior: reducedMotion() ? 'auto' : 'smooth' });
      const field = part.querySelector('[data-copy]');
      field?.focus({ preventScroll: true });
      if (select) field?.select?.();
      setActive(id);
    }
    function changed(){ showFields(); report(); draw(); }
    function addAfter(after){
      const id = `nd_gx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      sections.added.push({ id, after });
      edits[`${id}_h`] = t('copy_new_section', 'New section');
      undo = null;
      changed();
      goTo(id, true);
    }
    function remove(id){
      const add = sections.added.find((entry) => entry.id === id), part = array(data?.sections).find((entry) => entry.id === id);
      if (!add && !part?.removable) return;
      undo = { edits: { ...edits }, removed: [...sections.removed], added: sections.added.map((entry) => ({ ...entry })), at: id };
      if (add) {
        // A part added after this one now follows the part this one followed.
        sections.added = sections.added.filter((entry) => entry !== add);
        for (const entry of sections.added) if (entry.after === id) entry.after = add.after;
        delete edits[`${id}_h`]; delete edits[`${id}_t`];
      } else {
        sections.removed.push(id);
        for (const node of [part.heading, ...array(part.texts)]) if (node) delete edits[node];
      }
      if (active === id) active = '';
      changed();
    }
    function restore(){
      if (!undo) return;
      const { at } = undo;
      for (const id of Object.keys(edits)) delete edits[id];
      Object.assign(edits, undo.edits);
      sections.removed = undo.removed; sections.added = undo.added; undo = null;
      changed();
      goTo(at);
    }
    const onNav = (event) => {
      const button = event.target.closest?.('button'); if (!button || !data) return;
      const id = button.closest('[data-sec]')?.dataset.sec || '';
      if (button.matches('[data-sec-go]')) goTo(id);
      else if (button.matches('[data-sec-add-after]')) addAfter(id);
      else if (button.matches('[data-sec-delete]')) remove(id);
      else if (button.matches('[data-sec-add]')) { const list = ordered(); if (list.length) addAfter(list[list.length - 1].id); }
      else if (button.matches('[data-sec-undo]')) restore();
    };
    /** The fields not yet seen in full, below the column's edge: counted on the pill, which scrolls to the next one. */
    const hidden = () => {
      const edge = fieldsHost.getBoundingClientRect().bottom - 2;
      return [...fieldsHost.querySelectorAll('.gxd-copy-sec')].filter((node) => node.getBoundingClientRect().bottom > edge);
    };
    function below(){
      spy();
      const left = alive && fieldsHost.scrollHeight - fieldsHost.clientHeight - fieldsHost.scrollTop > 2 ? hidden() : [];
      more.hidden = !left.length;
      more.parentElement.classList.toggle('gxd-more', !!left.length);
      if (left.length) more.innerHTML = `${esc(t('copy_more', '{count} more below').replace('{count}', String(left.length)))} <i class="fas fa-arrow-down" aria-hidden="true"></i>`;
    }
    // A finger that lands on the pill and drags scrolls the fields under it, as anywhere else on them; a tap scrolls on.
    let pull = null, dragged = 0;
    const onPullDown = (event) => { pull = { id: event.pointerId, y: event.clientY, top: fieldsHost.scrollTop, moved: false }; };
    const onPullMove = (event) => {
      if (!pull || event.pointerId !== pull.id) return;
      if (Math.abs(event.clientY - pull.y) > 6) pull.moved = true;
      if (pull.moved) fieldsHost.scrollTop = pull.top - (event.clientY - pull.y);
    };
    const onPullUp = (event) => { if (!pull || event.pointerId !== pull.id) return; if (pull.moved) dragged = performance.now(); pull = null; };
    const onMore = () => {
      if (performance.now() - dragged < 400) return;
      const next = hidden()[0]; if (!next) return;
      const top = next.getBoundingClientRect().top - fieldsHost.getBoundingClientRect().top + fieldsHost.scrollTop;
      fieldsHost.scrollTo({ top: Math.max(0, top - 8), behavior: reducedMotion() ? 'auto' : 'smooth' });
    };
    async function load(){
      error.textContent = '';
      const [value, loaded] = await Promise.all([ctx.read('document-setup', 'copy', { args: { ...answers(), ...(keepEdits ? { keep_edits: true } : {}) } }), renderer()]);
      if (!alive) return;
      data = object(value); Renderer = loaded;
      if (!Array.isArray(data.sections)) data.sections = partsOf(data.fields);
      // A change that no longer names a field or part of this template (another style or answer since) is dropped.
      const parts = array(data.sections), anchors = new Set(parts.map((part) => part.id));
      sections.removed = sections.removed.filter((id) => parts.some((part) => part.id === id && part.removable));
      sections.added = sections.added.filter((add) => { const ok = anchors.has(add.after) && !anchors.has(add.id); if (ok) anchors.add(add.id); return ok; });
      const own = new Set(sections.added.flatMap((add) => [`${add.id}_h`, `${add.id}_t`]));
      for (const id of Object.keys(edits)) if (!own.has(id) && (!originals().has(id) || edits[id] === originals().get(id))) delete edits[id];
      showFields();
      draw();
      report();
      setTimeout(() => drop(lifted), 60);
    }
    const onInput = (event) => {
      const field = event.target.closest?.('[data-copy]'); if (!field) return;
      const id = field.dataset.copy, original = originals().get(id) ?? '';
      if (field.value === original) delete edits[id]; else edits[id] = field.value;
      if (field.tagName === 'TEXTAREA') grow(field);
      if (undo) { undo = null; showNav(); }
      else if (field.closest('.gxd-copy-sec')?.querySelector('[data-copy]') === field) showNav();
      report(); redraw(); below();
    };
    const onFocus = (event) => {
      const field = event.target.closest?.('[data-copy]'); if (!field) return;
      mark(field.dataset.copy);
      setActive(field.closest('.gxd-copy-sec')?.dataset.sec || '');
    };
    const onBlur = () => mark('');
    fieldsHost.addEventListener('input', onInput);
    fieldsHost.addEventListener('focusin', onFocus);
    fieldsHost.addEventListener('focusout', onBlur);
    fieldsHost.addEventListener('scroll', below, { passive: true });
    nav.addEventListener('click', onNav);
    more.addEventListener('click', onMore);
    more.addEventListener('pointerdown', onPullDown);
    more.addEventListener('pointermove', onPullMove);
    more.addEventListener('pointerup', onPullUp);
    more.addEventListener('pointercancel', onPullUp);
    const observer = window.ResizeObserver ? new ResizeObserver(() => redraw()) : null;
    observer?.observe(view);
    const fieldsObserver = window.ResizeObserver ? new ResizeObserver(() => below()) : null;
    fieldsObserver?.observe(fieldsHost);

    // ── Advanced: the template itself, in the template editor ──
    async function openStudio(){
      if (opening || studio || !advanced) return;
      opening = true; advanced.disabled = true; error.textContent = '';
      const layer = document.createElement('div');
      layer.className = 'gxd-studio';
      layer.innerHTML = `<div class="gxd-studio-app"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>`;
      (sheet?.querySelector('.gxs-sheet') || sheet || document.body).append(layer);
      studio = { layer, handle: null };
      try {
        // The editor opens the organization's own template: saved now with the answers and the wording so far.
        const saved = await saveTemplate(ctx, selections, { [copyKey]: { ...edits }, [sectionsKey]: sectionChanges(sections), [keepKey]: keepEdits });
        if (!alive || studio?.layer !== layer) return;
        const app = layer.querySelector('.gxd-studio-app');
        app.innerHTML = '';
        studio.handle = await window.FirstMateEmbeddableApps.mount(app, 'documents.studio', { orgId: ctx.orgId, surface: 'portal_tab', active: true, params: { embed: {
          templateId: (insurance ? clean(saved.insurance_template_id) : clean(saved.template_id)) || `tpl_setup_${clean(selections.document_kind) || 'proposal'}`,
          backLabel: t('copy_back_to_setup', 'Back to setup'),
          onClose: () => { void closeStudio(true); }
        } } });
        // Turned off since the step opened: the button goes, rather than staying to fail again.
        if (studio?.handle?.denied) { await closeStudio(false); advanced.remove(); return; }
      } catch (failure) {
        await closeStudio(false);
        if (alive) error.textContent = clean(failure?.message) || t('copy_studio_failed', 'The template editor didn’t open. Try again.');
      } finally { opening = false; if (alive) advanced.disabled = false; }
    }
    /** Back from the editor: the wording is read again from the template as it was published there. */
    async function closeStudio(reload){
      const open = studio; studio = null;
      if (!open) return;
      try { open.handle?.destroy?.(); } catch (_) {}
      open.layer.remove();
      if (!reload || !alive) return;
      keepEdits = true;
      for (const id of Object.keys(edits)) delete edits[id];
      sections.removed = []; sections.added = []; undo = null;
      report();
      nav.innerHTML = '';
      fieldsHost.innerHTML = '<div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div>';
      await load().catch(fail);
    }
    const onAdvanced = () => { void openStudio(); };
    advanced?.addEventListener('click', onAdvanced);
    const fail = (failure) => { if (!alive) return; drop(lifted); fieldsHost.innerHTML = ''; nav.innerHTML = ''; error.textContent = clean(failure?.message) || t('copy_failed', 'Your wording didn’t load. Go back and try again.'); };
    load().catch(fail);
    return {
      valid: () => !!data,
      summary,
      // Escape (and a phone's back) while the template editor is open goes back to the wording, as its back arrow does.
      escape: () => { if (!studio) return false; studio.layer.querySelector('[data-tpl-back]')?.click(); return true; },
      destroy(){
        // The document goes on with the setup, into the first proposal's preview.
        keepDocument(docHost);
        alive = false; clearTimeout(timer); observer?.disconnect(); fieldsObserver?.disconnect(); drop(lifted);
        void closeStudio(false);
        advanced?.removeEventListener('click', onAdvanced); advanced?.remove();
        fieldsHost.removeEventListener('input', onInput); fieldsHost.removeEventListener('focusin', onFocus); fieldsHost.removeEventListener('focusout', onBlur);
        fieldsHost.removeEventListener('scroll', below); more.removeEventListener('click', onMore); nav.removeEventListener('click', onNav);
        more.removeEventListener('pointerdown', onPullDown); more.removeEventListener('pointermove', onPullMove); more.removeEventListener('pointerup', onPullUp); more.removeEventListener('pointercancel', onPullUp);
        try { handle?.destroy?.(); } catch (_) {}
        if (!wasWide) sheet?.classList.remove('gxs-wide');
      }
    };
  }

  // ── The first proposal from the new template (FM-614) ─────────────────
  // For a proposal set up inside a project: the template is saved, a draft is made from it for this project's customer
  // and its own workflow runs here, in the Docs app (project.documents) as the Docs tab runs it, so this is how every
  // proposal starts from now on. The workflow's Previous on its first step comes back to the wording, a phone's back
  // walks its steps, and sending it finishes the setup on that proposal. Anywhere else (no project, another kind, a
  // setup another setup started) the setup finishes here. A company that makes both retail proposals and insurance
  // agreements (GP-55) first picks which to start with; Previous on the workflow's first step comes back to that choice.
  function firstPart(){
    const projectId = clean(ctx.where?.projectId || window.FirstMateGuides?.where?.()?.projectId);
    const kind = clean(selections.document_kind) || 'proposal';
    if (kind !== 'proposal' || !projectId || ctx.nested || !window.FirstMateEmbeddableApps?.mount) {
      el.innerHTML = '<div class="gxd"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
      setTimeout(() => { Promise.resolve(ctx.complete?.()).catch(() => {}); }, 0);
      return { valid: () => true };
    }
    const kinds = proposalKinds(selections), choosing = kinds === 'both';
    let alive = true, engine = null, service = null, finished = false, lifted = null, generation = 0;
    // Which to make: retail or insurance; with both, none until it is picked.
    let which = choosing ? '' : kinds === 'insurance' ? 'insurance' : 'retail';
    const sheet = el.closest('.gxs'), wasWide = !!sheet?.classList.contains('gxs-wide');
    sheet?.classList.add('gxs-wide');
    const pane = el.closest('.gxs-step');
    pane?.setAttribute('data-fill', '');
    let app = null, error = null;
    const leads = {
      retail: () => t('first_lead', 'Your proposal template is ready. From now on, every proposal starts here: fill in these steps for the customer and send it.'),
      insurance: () => t('first_lead_insurance', 'Your insurance agreement is ready. From now on, every agreement starts here: fill in the homeowner’s claim and send it to sign.')
    };
    function drawWorkflow(){
      el.innerHTML = `<div class="gxd gxd-fill gxd-first">
        <p class="gxd-first-lead"><i class="fas fa-circle-check" aria-hidden="true"></i><span>${esc(leads[which]())}</span></p>
        <div class="gxd-first-app"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span><span data-first-status>${esc(t('first_saving', 'Saving your template…'))}</span></div></div>
        <p class="gxd-error" role="alert"></p>
      </div>`;
      app = el.querySelector('.gxd-first-app'); error = el.querySelector('.gxd-error');
    }
    const firstChoices = [
      { id: 'retail', icon: 'fa-file-signature', title: ['gx_docs_setup_first_retail', 'A retail proposal'], hint: ['gx_docs_setup_first_retail_hint', 'Priced from the measurements and your price book, for the customer to sign.'] },
      { id: 'insurance', icon: 'fa-house-crack', title: ['gx_docs_setup_first_insurance', 'An insurance agreement'], hint: ['gx_docs_setup_first_insurance_hint', 'The homeowner signs that you do the work their insurance approves.'] }
    ];
    function drawChoice(){
      app = null; error = null;
      el.innerHTML = `<div class="gxd">
        <p class="gxd-first-lead"><i class="fas fa-circle-check" aria-hidden="true"></i><span>${esc(t('first_lead_both', 'Your retail proposal and your insurance agreement are ready. Which do you want to make first for this project? The other is always in New document.'))}</span></p>
        <div class="gxs-choices" style="--gxs-n:2" role="radiogroup" aria-label="${esc(ctx.L(ctx.step.title))}">${firstChoices.map((choice) => `
          <button type="button" class="gxd-tile gxs-choice" role="radio" data-first="${esc(choice.id)}" aria-checked="false">
            <span class="gxd-icon gxs-choice-icon" aria-hidden="true"><i class="fas ${esc(choice.icon)}"></i></span>
            <span class="gxs-choice-text"><strong>${esc(L(choice.title))}</strong><small>${esc(L(choice.hint))}</small></span>${choiceTick}
          </button>`).join('')}</div></div>`;
    }
    // The message is for the workflow's first step, once (GP-18): past it, it is gone, Previous included.
    const leaveLead = () => { if (Number(service?.workflowPosition?.()?.index) > 0) el.querySelector('.gxd-first-lead')?.remove(); };
    const status = (text) => { const node = el.querySelector('[data-first-status]'); if (node) node.textContent = text; };
    const intoPreview = () => {
      if (!lifted) return;
      const started = Date.now(), held = lifted;
      const look = () => {
        if (!alive || lifted !== held) return;
        const stage = app?.querySelector('[data-fmdw-preview-stage]');
        if (stage && stage.getBoundingClientRect().width) { glide(lifted, stage); const done = lifted; lifted = null; setTimeout(() => drop(done), 900); return; }
        if (Date.now() - started > 15000) { drop(lifted); lifted = null; return; }
        setTimeout(look, 120);
      };
      look();
    };
    async function finish(doc){
      if (finished || !alive) return;
      finished = true;
      ctx.change({ first_document_id: clean(doc?.id) || clean(selections.first_document_id), first_kind: which });
      // Done with the proposal: the setup finishes on it, without opening New document over it.
      try { await ctx.complete?.({ resume: false }); } catch (_) { finished = false; }
    }
    async function open(){
      const mine = generation;
      const live = () => alive && mine === generation;
      error.textContent = '';
      const saved = await saveTemplate(ctx, selections);
      if (!live()) return;
      status(which === 'insurance' ? t('first_opening_insurance', 'Starting your first agreement…') : t('first_opening', 'Starting your first proposal…'));
      const record = await window.PlatformAPI.projects.get(ctx.orgId, projectId).catch(() => null);
      const project = { ...object(object(record?.document).data), id: projectId, organization_id: ctx.orgId };
      if (!live()) return;
      app.innerHTML = '';
      engine = await window.FirstMateEmbeddableApps.mount(app, 'project.documents', { orgId: ctx.orgId, projectId, project, surface: 'project_modal', active: true, params: { embed: {
        enabled: true, history: false, focus: false,
        onReady: (api) => { service = api; },
        onWorkflowStep: () => { leaveLead(); ctx.syncBack?.(); },
        workflowOptions: {
          showWorkflowTitle: false, phoneSteps: 'bottom',
          onStepTitle: ({ title } = {}) => { if (live()) ctx.setTitle?.(title); },
          // Previous on the workflow's first step goes back to the choice of which to make, else to the wording.
          onBackFromFirst: () => { if (!live()) return; if (choosing) backToChoice(); else ctx.back?.(); }
        }
      } } });
      if (!live()) return;
      if (!service || engine?.denied) throw new Error(t('first_unavailable', 'Documents could not open here. Finish the setup and make your proposal in Docs.'));
      const onFinish = (doc) => { void finish(doc); };
      const templateId = which === 'insurance' ? clean(saved.insurance_template_id) || clean(saved.template_id) || 'tpl_setup_insurance_agreement' : clean(saved.template_id) || 'tpl_setup_proposal';
      // A draft started here before, of the same kind, is picked up again.
      const previous = (clean(selections.first_kind) || (kinds === 'insurance' ? 'insurance' : 'retail')) === which ? clean(selections.first_document_id) : '';
      const existing = previous ? await window.DocumentsAPI?.documents?.get?.(ctx.orgId, previous).then((result) => object(result.document || result.doc || result)).catch(() => null) : null;
      if (!live()) return;
      if (existing?.id && clean(existing.status) === 'draft' && clean(existing.project_id) === projectId) await service.openDocument(existing, { onFinish });
      else {
        const doc = await service.startFromTemplate(templateId, { onFinish });
        if (live()) ctx.change({ first_document_id: clean(doc?.id), first_kind: which });
      }
      leaveLead();
      intoPreview();
      ctx.syncBack?.();
    }
    function start(){
      drawWorkflow();
      if (!lifted && !choosing) {
        // The wording's document waits where it was, then slides into the workflow's preview once that is drawn.
        lifted = liftDocument(sheet || document.body);
        // Meanwhile it moves down out of the way of the message above, on the side the workflow's preview will be (GP-13).
        if (lifted) {
          const box = settledRect(app), from = lifted.rect, width = Math.min(from.width, box.width);
          glideTo(lifted, { left: Math.max(box.left, Math.min(from.left, box.left + box.width - width)), top: box.top, width, height: box.height });
        }
      }
      open().catch((failure) => {
        if (!alive || !app) return;
        drop(lifted); lifted = null;
        app.innerHTML = `<div class="gxd-busy"><button type="button" class="gxd-advanced" data-retry>${esc(t('first_retry', 'Try again'))}</button></div>`;
        error.textContent = clean(failure?.message) || t('first_failed', 'Your first proposal didn’t start.');
        app.querySelector('[data-retry]')?.addEventListener('click', () => { app.innerHTML = `<div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span><span data-first-status></span></div>`; void open().catch((again) => { if (alive && error) error.textContent = clean(again?.message); }); });
      });
    }
    function stopWorkflow(){
      generation += 1;
      try { engine?.destroy?.(); } catch (_) {}
      engine = null; service = null;
      drop(lifted); lifted = null;
    }
    function backToChoice(){
      stopWorkflow();
      which = '';
      drawChoice();
      ctx.setTitle?.('');
      // The sheet's own Back and the phone's back are the step's again.
      ctx.change({});
      ctx.syncBack?.();
    }
    const onChoose = (event) => {
      const tile = event.target.closest?.('[data-first]'); if (!tile || which) return;
      which = tile.dataset.first;
      tile.setAttribute('aria-checked', 'true');
      ctx.change({ first_kind: which });
      ctx.syncBack?.();
      start();
    };
    el.addEventListener('click', onChoose);
    if (choosing) {
      // Nothing is carried into a choice: the agreement's page was last, and either document may come next.
      handoff = null;
      drawChoice();
    } else start();
    const stepsBehind = () => Math.max(0, Number(service?.workflowPosition?.()?.index) || 0);
    return {
      // While the choice is on screen the sheet's Back is the way back; Continue waits for a pick (which starts it).
      valid: () => !choosing || !!which,
      hint: () => t('first_choose_hint', 'Choose which to make first.'),
      // The workflow is the step's navigation: Previous on its first step, Send on its last (the sheet's footer hides).
      get handlesNavigation(){ return !!which; },
      backDepth: () => stepsBehind() + (choosing && which ? 1 : 0),
      back: () => {
        if (stepsBehind()) return service.workflowBack() === true;
        if (choosing && which) { backToChoice(); return true; }
        return false;
      },
      destroy(){
        alive = false; stopWorkflow();
        el.removeEventListener('click', onChoose);
        if (!wasWide) sheet?.classList.remove('gxs-wide');
      }
    };
  }
}
export default mount;
