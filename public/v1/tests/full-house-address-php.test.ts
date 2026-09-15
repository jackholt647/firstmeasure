import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

test('full-house PHP requires coordinates and forwards the selected address without geocoding', async () => {
  const submitted: unknown[] = [];
  const upstream = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.endsWith('/capability')) return response.end('{"email":"owner@example.test"}');
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      submitted.push(JSON.parse(body)); response.statusCode = 201;
      return response.end(JSON.stringify({ folder: 'fullhouse_' + 'a'.repeat(32) }));
    }
    response.end('{"projects":[]}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const phpPort = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'full-house-address-'));
  const target = path.resolve('../measure/internal/full_house.php').replace(/\\/g, '/');
  const router = path.join(temporary, 'router.php');
  await writeFile(router, `<?php session_save_path(${JSON.stringify(temporary.replace(/\\/g, '/'))}); session_id('address-test'); session_start(); $_SESSION=['user_email'=>'owner@example.test','full_house_csrf'=>'test-csrf']; session_write_close(); require ${JSON.stringify(target)};`);
  const binary = spawnSync('php', ['-r', 'echo PHP_BINARY;'], { encoding: 'utf8' }).stdout.trim();
  const extensions = process.platform === 'win32' ? ['-d', `extension_dir=${path.join(path.dirname(binary), 'ext')}`, '-d', 'extension=curl'] : [];
  const child = spawn(binary, [...extensions, '-S', `127.0.0.1:${phpPort}`, router], {
    env: { ...process.env, FIRSTMEASURE_API_BASE: `http://127.0.0.1:${port}/v1/firstmeasure`, FIRSTMEASURE_FULL_HOUSE_SIGNING_SECRET: 'test-signing-secret' }, stdio: 'ignore'
  });
  const url = `http://127.0.0.1:${phpPort}/full_house.php`;
  try {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(url)).ok) break; } catch { /* wait for the test PHP server */ }
      if (attempt >= 50) throw Error('Test PHP server failed to start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const post = (body: object) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Full-House-CSRF': 'test-csrf' }, body: JSON.stringify(body) });
    for (const body of [{ address: 'Unselected text' }, { address: 'Test', lat: null, lng: null }, { address: 'Test', lat: 91, lng: -122 }]) assert.equal((await post(body)).status, 400);
    assert.equal(submitted.length, 0, 'invalid locations never reach project creation');
    assert.equal((await post({ address: '123 Selected Street, Test City, CA, USA', lat: 37.42, lng: -122.08, measurement_scope: 'roof', process_imagery: false })).status, 201);
    assert.deepEqual(submitted, [{ address: '123 Selected Street, Test City, CA, USA', lat: 37.42, lng: -122.08, measurement_scope: 'full_house' }]);
    const html = await (await fetch(url)).text();
    assert.doesNotMatch(html, /id="scope"|type="checkbox"/);
    assert.match(html, /full_house_address\.js/);
  } finally {
    child.kill();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
