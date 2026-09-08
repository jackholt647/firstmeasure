import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../portal/login.php', import.meta.url), 'utf8');
const start = source.indexOf('    function authErrorMessage(');
const end = source.indexOf('    function attributionPayload(', start);
assert.ok(start > 0 && end > start);
let resized = false;
const context = vm.createContext({ requestAnimationFrame: fn => fn(), setFormAreaHeightTo: () => { resized = true; } });
vm.runInContext(source.slice(start, end), context);
const message = context.authErrorMessage;

test('duplicate phone and email have clear actionable messages', () => {
  assert.match(message({ error: 'identity_phone_exists' }), /phone number is already connected to an existing account/);
  assert.match(message({ error: 'identity_email_exists' }), /email address.*existing account/);
  assert.match(message({ code: 'identity_phone_exists' }), /phone number/);
});

test('known auth failures have readable messages without raw codes', () => {
  for (const code of ['identity_exists', 'invalid_credentials', 'identity_phone_ambiguous', 'not_found', 'identity_phone_not_found', 'invalid_email', 'invalid_phone_number', 'missing_login_identifier', 'registration_in_progress', 'identity_inactive', 'user_disabled', 'membership_required', 'google_account_mismatch', 'google_credential_required', 'invalid_google_credential', 'unverified_google_email', 'invalid_recovery_token', 'sms_phone_unavailable', 'telnyx_verify_send_failed', 'postmark_send_failed', 'authentication_required', 'session_expired', 'session_revoked', 'csrf_required', 'connection_error']) {
    const result = message({ error: code, message: 'Private provider failure details' });
    assert.ok(result.length > 20, code);
    assert.ok(!result.includes(code) && !result.includes('Private provider'), code);
    assert.ok(!result.includes('We could not complete your request'), code);
  }
});

test('legacy verification and password errors remain actionable', () => {
  assert.match(message({ error: 'Invalid or expired code.' }), /Request a new code/);
  assert.match(message({ error: 'Password too short' }), /at least 6 characters/);
  assert.match(message({ error: 'Password reset is not authorized.' }), /Verify your recovery code/);
});

test('unknown errors never leak raw codes or backend details; rate limits are explicit', () => {
  for (const data of [null, {}, { error: 'new_internal_code', message: 'SQL secret detail' }, { error: { detail: 'private' } }, { error: 'constructor' }, { error: '<script>private</script>' }]) {
    assert.match(message(data), /Please try again/);
    assert.doesNotMatch(message(data), /SQL|private|internal_code|script/);
  }
  assert.match(message({ status_code: 429 }), /Too many attempts/);
});

test('all five auth forms use shared presentation and expand for visible error text', () => {
  assert.doesNotMatch(source, /err\.innerText\s*=\s*data\.(?:error|message)/);
  assert.equal((source.match(/showAuthError\(err, data\)/g) || []).length, 5);
  const element = { style: {}, closest: () => ({}) };
  context.showAuthError(element, { error: 'identity_phone_exists' });
  assert.equal(element.style.display, 'block');
  assert.match(element.innerText, /phone number/);
  assert.equal(resized, true);
});
