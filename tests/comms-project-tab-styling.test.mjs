// The project Comms tab (FM-474) is drawn in the organization's primary color, never black,
// and has a phone layout like Photos and Docs: one header row, a channel strip that scrolls
// sideways (five channels never push the tab wider than the screen), and a way back from an
// open portal chat to the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/libraries/apps/comms/project.js'), 'utf8');
const css = source.slice(source.indexOf('function css(){'), source.indexOf('// ── Shell'));
const rule = (selector) => {
  const match = new RegExp(`(?:^|[\\s}])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(match, `no rule for ${selector}`);
  return match[1];
};

test('filled accents use the primary color, not black', () => {
  for (const selector of ['.fmco-btn.primary', '.fmco-msg.outbound', '.fmco-agent-msg.user', '.fmco-agent-send', '.fmco-ai-btn.active']) {
    const body = rule(selector);
    assert.match(body, /background:var\(--primary,/, `${selector} background`);
    assert.match(body, /color:var\(--on-primary,/, `${selector} text`);
  }
  assert.match(rule('.fmco-tab.active,.fmco-tab.active:hover'), /background:var\(--primary,[^;]*;color:var\(--on-primary,/);
  assert.doesNotMatch(css, /background:#(101828|111827|000|000000|232f47)\b/i, 'a black fill is back');
});

test('the channel tabs scroll instead of widening the tab', () => {
  const tabs = rule('.fmco-tabs');
  assert.match(tabs, /overflow-x:auto/);
  assert.match(tabs, /min-width:0/);
  assert.doesNotMatch(tabs, /flex:0 0 auto/);
});

test('a phone layout exists at the platform window breakpoint', () => {
  const start = css.indexOf('@media(max-width:760px){');
  assert.ok(start > 0, 'no phone block');
  const phone = css.slice(start, css.indexOf('\n      }\n', start));
  for (const piece of ['.fmco-head-icon{display:inline-flex', '.fmco-ai-btn>span{display:none}', '.fmco-tabs{order:3;flex:1 1 100%', '.fmco-agent-col{position:absolute;inset:0', '.fmco-phone-only{display:inline-flex}']) {
    assert.ok(phone.includes(piece), `phone block lacks ${piece}`);
  }
  assert.match(source, /<span class="fmco-head-icon" aria-hidden="true">/);
});

test('an open portal chat can go back to the list on a phone', () => {
  assert.match(source, /data-co-chat-close/);
  assert.match(source, /\[data-co-chat-close\]'\)\?\.addEventListener\('click', \(\) => \{ state\.activeChatId = ''; state\.chatPicking = true;/);
  assert.equal((source.match(/!state\.activeChatId && !state\.chatPicking &&/g) || []).length, 2, 'both auto-selects respect chatPicking');
});

// FM-512: the group-text hint is an (i) on the To line of a new text, not a line under Send.
test('the new-text group hint is a tip on the To line', () => {
  const start = source.indexOf('${state.smsComposeOpen ? `');
  const compose = source.slice(start, source.indexOf('` : active ? `', start));
  const to = compose.slice(compose.indexOf('<div class="fmco-recipient-row has-tip">'), compose.indexOf('</div>', compose.indexOf('data-co-sms-to')));
  assert.match(to, /data-co-sms-to>\$\{String\(hintTip\(globalThis\.PlatformLanguage\?\.text\("comms","m_6530a8d89e9c93"/);
  assert.doesNotMatch(compose, /fmco-composer-hint[^]*m_6530a8d89e9c93/, 'the hint is back under the composer');
  assert.match(source, /bindHintTips\(root\);/);
  assert.match(rule('.fmco-tip-host'), /position:relative/);
  assert.match(rule('.fmco-hint-tip'), /position:absolute;[^}]*top:calc\(100% \+ 6px\)/);
});

// FM-514: on a phone the overview's channel cards (Email, Texts, Calls) share one row, and an
// empty channel shows its 0 without a "No messages yet" line under it.
test('the overview channel cards share one row on a phone and say nothing when empty', () => {
  const start = css.indexOf('@media(max-width:760px){');
  const phone = css.slice(start, css.indexOf('\n      }\n', start));
  assert.ok(phone.includes('.fmco-cards{grid-template-columns:repeat(var(--fmco-channels,2),minmax(0,1fr))'), 'phone cards are not one column per channel');
  assert.ok(phone.includes('.fmco-setup-card{grid-column:1/-1}'), 'a setup card squeezes into a channel column');
  assert.ok(phone.includes('.fmco-card:not(.fmco-setup-card) .fmco-card-sub{display:none}'), 'the received/last line is back in a narrow card');
  assert.match(source, /<div class="fmco-cards" data-co-channels="\$\{cards\.length\}" style="--fmco-channels:\$\{Math\.max\(1, cards\.length\)\}">/);
  assert.doesNotMatch(source, /No messages yet/);
});
