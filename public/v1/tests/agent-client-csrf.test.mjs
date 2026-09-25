import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const clients = [
  { path:'../../libraries/assistant-api/assistant-api.js', name:'AssistantAPI', send:(api) => api.createThread('org-1', {}) },
  { path:'../../libraries/agents-api/agents-api.js', name:'AgentsAPI', send:(api) => api.createThread('org-1', 'global', {}) }
];

async function sentHeaders(client, sessionName, cookie){
  let requestOptions;
  const context = {
    window:{ __APP:sessionName ? { platformSessionCookieName:sessionName } : {} },
    document:{ cookie },
    location:{ origin:'https://dev.1m8.ai', hostname:'dev.1m8.ai' },
    FormData:class FormData {},
    fetch:async (_url, options) => {
      requestOptions = options;
      return { ok:true, status:200, text:async () => '{"ok":true}' };
    }
  };
  vm.runInNewContext(readFileSync(new URL(client.path, import.meta.url), 'utf8'), context);
  await client.send(context.window[client.name]);
  return requestOptions.headers;
}

for (const client of clients) {
  test(`${client.name} sends the configured development session CSRF token`, async () => {
    const headers = await sentHeaders(client, 'fm_platform_dev_session',
      'fm_platform_session_csrf=stale; fm_platform_dev_session_csrf=dev%3Atoken');
    assert.equal(headers['X-Platform-CSRF'], 'dev:token');
  });

  test(`${client.name} retains the production cookie fallback`, async () => {
    const headers = await sentHeaders(client, '', 'fm_platform_session_csrf=prod%3Atoken');
    assert.equal(headers['X-Platform-CSRF'], 'prod:token');
  });

  test(`${client.name} does not use a different session's token`, async () => {
    const headers = await sentHeaders(client, 'fm_platform_dev_session', 'fm_platform_session_csrf=stale');
    assert.equal(headers['X-Platform-CSRF'], undefined);
  });
}
