import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';

const source = readFileSync(new URL('../internal/api.ts', import.meta.url), 'utf8');
const body = source.split('async function injectJson(')[1].split('async function parseJsonish')[0].split('function parseJsonish')[0];
const functionBody = body.slice(body.indexOf(' {') + 2).trim().replace(/}\s*$/, '').replace('payload as any', 'payload');
const dispatch = new Function('env', 'asObject', `return async function(app, method, url, payload) { ${functionBody} }`);

test('legacy in-process dispatch passes proxy guard for GET and POST; external callers remain blocked', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers['x-firstmeasure-legacy-proxy'] !== 'test-only-proxy-token') {
      return reply.code(403).send({ error: 'legacy_proxy_required' });
    }
  });
  app.get('/status', async () => ({ ok: true }));
  app.post('/claim', async request => ({ ok: true, actor: request.body.actor }));
  const inject = dispatch({ clusterNodeRole: 'legacy', legacyProxySecret: 'test-only-proxy-token' }, value => value);
  try {
    assert.equal((await app.inject('/status')).statusCode, 403);
    assert.deepEqual(await inject(app, 'GET', '/status'), { ok: true });
    assert.deepEqual(await inject(app, 'POST', '/claim', { actor: 'test-tech' }), { ok: true, actor: 'test-tech' });
    const web = dispatch({ clusterNodeRole: 'web', legacyProxySecret: 'test-only-proxy-token' }, value => value);
    assert.equal((await web(app, 'GET', '/status')).status_code, 403);
  } finally { await app.close(); }
});
