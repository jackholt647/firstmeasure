import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const clients = { platform: 'PlatformAPI', payments: 'PaymentsAPI', canvassing: 'CanvassingAPI', materials: 'MaterialsAPI', 'lead-intake': 'LeadIntakeAPI', email: 'EmailAPI', proposals: 'ProposalsAPI' };
test('cloned report links use the current artifact service without rewriting external URLs', () => {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../../libraries/platform-api/platform-api.js', import.meta.url), 'utf8'), { window, location: { origin: 'https://dev.1m8.ai', hostname: 'dev.1m8.ai' }, URL });
  const resolve = value => window.PlatformAPI.projectMedia.artifactUrl(value, { firstMeasureUrlBuilder: path => 'https://dev.1m8.ai/v1/firstmeasure/' + path });
  assert.equal(resolve('https://app.1m8.ai/v1/firstmeasure/projects/abc/artifacts/Summary.pdf?download=1'), 'https://dev.1m8.ai/v1/firstmeasure/projects/abc/artifacts/Summary.pdf?download=1');
  assert.equal(resolve('/v1/firstmeasure/projects/abc/artifacts/model_data.xml'), 'https://dev.1m8.ai/v1/firstmeasure/projects/abc/artifacts/model_data.xml');
  for (const value of [null, '', 'https://example.com/v1/firstmeasure/projects/abc/artifacts/a.pdf', 'https://app.1m8.ai/portal/', 'https://app.1m8.ai.evil.test/v1/firstmeasure/projects/abc/artifacts/a.pdf']) assert.equal(resolve(value), value);
});
for (const [name, exportName] of Object.entries(clients)) {
  test(`${name}: isolated CSRF cookies, legacy default, and malformed-cookie handling`, async () => {
    const source = readFileSync(new URL(`../../libraries/${name}-api/${name}-api.js`, import.meta.url), 'utf8');
    for (const [sessionName, cookie, expected] of [
      ['fm_platform_session_development', 'fm_platform_session_csrf=wrong; fm_platform_session_development_csrf=dev%2Btoken', 'dev+token'],
      [undefined, 'fm_platform_session_csrf=legacy', 'legacy'],
      ['fm_platform_session_development', 'fm_platform_session_csrf=wrong', undefined],
      ['invalid;name', 'fm_platform_session_csrf=wrong', undefined],
      ['fm_platform_session_development', 'fm_platform_session_development_csrf=%xx', undefined],
    ]) {
      let sent;
      const window = { __APP: { platformSessionCookieName: sessionName } };
      vm.runInNewContext(source, { window, document: { cookie }, location: { hostname: 'dev.1m8.ai', protocol: 'https:', origin: 'https://dev.1m8.ai' }, FormData, URLSearchParams, URL, console, fetch: async (_url, options) => { sent = options; return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }; } });
      assert.ok(window[exportName], exportName);
      await window[exportName].request('/test', { method: 'POST', body: { test: true } });
      assert.equal(sent.headers['X-Platform-CSRF'], expected);
      await window[exportName].request('/test', { method: 'GET' });
      assert.equal(sent.headers['X-Platform-CSRF'], undefined);
    }
  });
}
