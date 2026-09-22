import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const accountSwitcher = await readFile(new URL('../../libraries/account-switcher/account-switcher.js', import.meta.url), 'utf8');
const signupWidget = await readFile(new URL('../../portal/landing/shared/signup-widget.js', import.meta.url), 'utf8');

test('add-account opens in login mode and uses the remembered-account endpoint', () => {
  assert.match(accountSwitcher, /data-mode="login" data-show-login="true"/);
  assert.match(accountSwitcher, /loginRequest:\s*async[\s\S]*this\.request\('\/auth\/accounts\/add'/);
});

test('signup widget supports a dedicated login request without running generic session sync', () => {
  assert.match(signupWidget, /function buildWidget\(host, options = \{\}\)/);
  assert.match(signupWidget, /typeof options\.loginRequest === 'function'[\s\S]*options\.loginRequest\(fd\)/);
  assert.match(signupWidget, /if \(typeof options\.loginRequest !== 'function'\) await syncPlatformBrowserSession\(fd\)/);
});

test('account ellipsis opens an action menu instead of removing the account directly', () => {
  assert.match(accountSwitcher, /data-fm-account-more=.*aria-haspopup="menu"/);
  assert.match(accountSwitcher, /data-fm-account-more[^]*this\.actionAccountKey[^]*this\.renderList\(\)/);
  assert.match(accountSwitcher, /class="fm-account-row-actions" role="menu"/);
  assert.match(accountSwitcher, /data-fm-account-remove=.*role="menuitem"/);
  assert.doesNotMatch(accountSwitcher, /data-fm-account-remove[^>]*fa-ellipsis-vertical/);
  assert.match(accountSwitcher, /\.fm-account-row-actions\{position:absolute/);
});
