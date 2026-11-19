// The Call Center (FM-497) on a phone: the portal's top bar carries the title, so the app's
// own heading is hidden, and the desk, filters and cards use a
// compact phone layout. Its views are the shared tab strip (FM-550): Personal / Call center /
// Manager view / Settings, and Communications' views and Settings are the same strip. GP-63: the
// strip is in the header: beside the title on a desktop (like My Projects), the full-width row
// under it on a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, 'public/libraries/apps/comms', file), 'utf8');
const workspace = read('workspace.js');
const css = read('communications.css');
const ui = read('communications-ui.js');

const phoneBlock = () => {
  const marker = '/* Phone: the portal\'s mobile top bar carries the title, so the call center starts with one compact control row. */';
  const start = css.indexOf(marker);
  assert.ok(start > 0, 'no call center phone block');
  const open = css.indexOf('@media(max-width:820px){', start);
  assert.ok(open > start, 'phone block is not at the 820px breakpoint');
  return css.slice(open, css.indexOf('\n}\n', open));
};

test('the views and Settings are one shared tab strip', () => {
  // Call Center: its three views and Settings, in its header when it stands alone, otherwise in the slot under
  // Communications' header; Settings only when it stands alone, since Communications' own strip ends with Settings.
  assert.match(workspace, /const subtabs='<div class="fmcm-subtabs" data-subtabs hidden><\/div>',centerAlone=options\.standalone==='center'&&!options\.projectId;/);
  assert.match(workspace, /\$\{options\.projectId\?'':header\(\)\}\$\{centerAlone\?'':subtabs\}/);
  assert.match(workspace, /if\(centerAlone\)\{state\.centerTabs='';if\(state\.view==='center'\)render\(\);\}/, 'a new header gets its strip again');
  assert.match(workspace, /chrome\.tabStrip\(\{label:'Call Center view',attribute:'data-center-mode',selected:state\.centerMode,items:\[/);
  assert.match(workspace, /\{id:'call',title:'Call center',short:'Calls',icon:'fa-headset'\}/);
  assert.match(workspace, /\.\.\.\(options\.standalone==='center'\?\[settingsTab\]:\[\]\)/);
  assert.match(workspace, /const settingsTab=\{id:'setup',title:'Settings',icon:'fa-gear',attribute:'data-view'\};/);
  assert.match(workspace, /root\.querySelector\('\[data-subtabs\]'\)\.hidden=view!=='center';/);
  // Communications: the group's members and Settings as the header's strip, no gear among the header tools.
  assert.match(workspace, /strip:centerAlone\?subtabs:options\.standalone\?'':chrome\.tabs\('communications',state\.view,'data-view',\{\},\{strip:true,extra:\[settingsTab\]\}\)/);
  assert.match(workspace, /actions:options\.standalone && options\.standalone!=='center'\?/);
  assert.ok(!/fmcc-switch|fmcc-modebar|fmcc-settings/.test(workspace + css), 'the old Call Center switch is gone');
  assert.match(workspace, /return picker\?`<div class="fmcc-top">\$\{picker\}<\/div>`:'';/, 'only a department picker sits above a view');
  assert.match(workspace, /<label class="fmcc-department"><span>\$\{esc\(context\.department_label/);
  const chat = fs.readFileSync(path.join(root, 'public/libraries/apps/chat/app.js'), 'utf8');
  assert.match(chat, /\['lists','Call lists','fa-list-check','Lists'\]/, 'group members carry an icon and a short name');
});

test('a phone shows no second or third title', () => {
  const phone = phoneBlock();
  for (const piece of [
    '.fmcm>[data-app-header] .app-heading{display:none}',
    '.fmcm>[data-app-header]:not(:has(.app-header-tools>*,app-tab-strip)){display:none!important}',
  ]) assert.ok(phone.includes(piece), `phone block lacks ${piece}`);
});

test('each view opens at its content, with no title of its own', () => {
  // GP-80: the header and the view strip already say where you are. No "Call Center" intro and no
  // "Your call history" / "Calling desk" / "Manager view" heading on any device; their buttons moved into the content.
  for (const gone of ['fmcc-title', 'fmcc-section-head', 'fmcc-meta', '<h2>Call Center</h2>', 'Your call history', 'calls match these filters', '<h3>Calling desk</h3>', '<h3>Manager view</h3>'])
    assert.ok(!workspace.includes(gone) && !css.includes(gone), `${gone} is back`);
  assert.match(workspace, /<section class="fmcc-section">\$\{filters\}<div class="fmcc-history">/, 'Personal starts at its search');
  assert.match(workspace, /<button class="fmcc-new-call" data-action="new-call">\$\{icon\('phone'\)\} New call<\/button><\/div>`;/, 'New call is in the desk controls');
  assert.match(workspace, /<section class="fmcc-section"><div class="fmcc-stats">/, 'Manager view starts at its figures');
  assert.match(workspace, /<header><h4>Callers<\/h4><div class="fmcc-head-tools"><span>[^<]*on roster[^<]*<\/span><button data-action="reload">/, 'Refresh is in the Callers card');
  assert.ok(css.includes('.fmcc-dial-controls .fmcc-new-call{margin-left:auto}'));
});

test('desk controls, filters and cards are compact on a phone', () => {
  const phone = phoneBlock();
  for (const piece of [
    '.fmcc .fmcc-filters,.fmcc .fmcc-dial-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))',
    '.fmcc .fmcc-filters{grid-template-columns:repeat(3,minmax(0,1fr))}',
    '.fmcc .fmcc-filters .fmcc-search{grid-column:1/-1}',
    '.fmcc .fmcc-dial-controls>button{width:100%;min-height:44px;margin:0}',
    '.fmcc .fmcm-empty{min-height:0',
    '.fmcc .fmcc-stat{padding:10px 12px}',
  ]) assert.ok(phone.includes(piece), `phone block lacks ${piece}`);
});

test('on a phone a header holding only the strip is just the strip', () => {
  // GP-63: the strip moved into the header; with no title or tools to show, the header adds nothing around it.
  assert.ok(css.includes('@media(max-width:800px){.fmcm>[data-app-header]:not(:has(.app-header-tools>*)){padding:0!important;min-height:0;gap:0!important}.fmcm>[data-app-header]:not(:has(.app-header-tools>*))>.app-header-strip{flex-basis:100%;margin:0}}'));
  assert.ok(css.includes('.fmcm>[data-app-header]:has(app-tab-strip)+.fmcm-subtabs>app-tab-strip{border-top:0}'));
});

test('the stylesheet version moved with the layout', () => {
  // Later issues bump it again; it must be at least the GP-63 one (the strip moved into the header).
  const [, day] = /communications\.css\?v=(\d{8})-/.exec(ui) || [];
  assert.ok(day >= '20261119' && !/communications\.css\?v=20261119-gp12-busy/.test(ui), 'communications.css ?v= is older than GP-63');
});
