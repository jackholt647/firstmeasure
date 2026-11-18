// The Call Center (FM-497) on a phone: the portal's top bar carries the title, so the app's
// own heading and the "Call Center" intro are hidden, and the desk, filters and cards use a
// compact phone layout. Its views are the shared tab strip (FM-550): Personal / Call center /
// Manager view / Settings under the header, on a phone and on a desktop; Communications'
// views and Settings are the same strip.
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
  // Call Center: its three views and Settings, in the slot under the header; Settings only when it stands alone,
  // since Communications' own strip already ends with Settings.
  assert.match(workspace, /<div class="fmcm-subtabs" data-subtabs hidden><\/div>/);
  assert.match(workspace, /chrome\.tabStrip\(\{label:'Call Center view',attribute:'data-center-mode',selected:state\.centerMode,items:\[/);
  assert.match(workspace, /\{id:'call',title:'Call center',short:'Calls',icon:'fa-headset'\}/);
  assert.match(workspace, /\.\.\.\(options\.standalone==='center'\?\[settingsTab\]:\[\]\)/);
  assert.match(workspace, /const settingsTab=\{id:'setup',title:'Settings',icon:'fa-gear',attribute:'data-view'\};/);
  assert.match(workspace, /root\.querySelector\('\[data-subtabs\]'\)\.hidden=view!=='center';/);
  // Communications: the group's members and Settings as the strip under the header, no gear among the header tools.
  assert.match(workspace, /strip:options\.standalone\?'':chrome\.tabs\('communications',state\.view,'data-view',\{\},\{strip:true,extra:\[settingsTab\]\}\)/);
  assert.match(workspace, /actions:options\.standalone && options\.standalone!=='center'\?/);
  assert.ok(!/fmcc-switch|fmcc-modebar|fmcc-settings/.test(workspace + css), 'the old Call Center switch is gone');
  assert.match(workspace, /<div class="fmcc-top"><div class="fmcc-title"><h2>Call Center<\/h2>/);
  assert.match(workspace, /<label class="fmcc-department"><span>\$\{esc\(context\.department_label/);
  const chat = fs.readFileSync(path.join(root, 'public/libraries/apps/chat/app.js'), 'utf8');
  assert.match(chat, /\['lists','Call lists','fa-list-check','Lists'\]/, 'group members carry an icon and a short name');
});

test('a phone shows no second or third title', () => {
  const phone = phoneBlock();
  for (const piece of [
    '.fmcm>[data-app-header] .app-heading{display:none}',
    '.fmcm>[data-app-header]:not(:has(.app-header-tools>*)){display:none!important}',
    '.fmcc .fmcc-title{display:none}',
    '.fmcc .fmcc-section-head h3,.fmcc .fmcc-section-head>div:not(.fmcc-meta){display:none}',
  ]) assert.ok(phone.includes(piece), `phone block lacks ${piece}`);
  assert.match(workspace, /<div class="fmcc-section-head"><div class="fmcc-meta"><h3>Your call history<\/h3><p>\$\{state\.centerTotal\} calls match/);
});

test('desk controls, filters and cards are compact on a phone', () => {
  const phone = phoneBlock();
  for (const piece of [
    '.fmcc .fmcc-filters,.fmcc .fmcc-dial-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))',
    '.fmcc .fmcc-filters{grid-template-columns:repeat(3,minmax(0,1fr))}',
    '.fmcc .fmcc-filters .fmcc-search,.fmcc .fmcc-dial-controls>button{grid-column:1/-1}',
    '.fmcc .fmcm-empty{min-height:0',
    '.fmcc .fmcc-stat{padding:10px 12px}',
  ]) assert.ok(phone.includes(piece), `phone block lacks ${piece}`);
});

test('the stylesheet version moved with the phone layout', () => {
  // Later issues bump it again; it must be at least the FM-550 one (the tab strip replaced the switch).
  const [, day, issue] = /communications\.css\?v=(\d{8})-fm-?(\d+)/.exec(ui) || [];
  assert.ok(day >= '20261118' && Number(issue) >= 550, 'communications.css ?v= is older than FM-550');
});
