import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createHmac } from 'node:crypto';

test('PHP renders exteriors only for authorized full-house IDs; roof markup stays clean', async () => {
  let allowed = true;
  let lastPath = "";
  const server = createServer((request, response) => {
    lastPath = request.url || '';
    const expected = createHmac('sha256', 'test-full-house-signing-secret').update(`${request.headers['x-full-house-user']}\n${request.headers['x-full-house-time']}`).digest('hex');
    const access = allowed && request.headers['x-full-house-user'] === 'owner@example.test' && request.headers['x-full-house-signature'] === expected;
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.endsWith('/internal-exteriors/capability')) {
      response.statusCode = access ? 200 : 404;
      response.end(JSON.stringify(access ? { ok: true, email: 'owner@example.test' } : { error: 'not_found' }));
    } else { response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const sessions = await mkdtemp(path.join(os.tmpdir(), 'full-house-php-'));
  const binary = spawnSync('php', ['-r', 'echo PHP_BINARY;'], { encoding: 'utf8' }).stdout.trim();
  const extensions = process.platform === 'win32' ? ['-d', `extension_dir=${path.join(path.dirname(binary), 'ext')}`, '-d', 'extension=curl'] : [];
  const render = (folder: string, email = 'owner@example.test', action = '') => new Promise<{ html: string; errors: string }>((resolve, reject) => {
    const php = `session_save_path(${JSON.stringify(sessions)}); session_id('fullhousetest'); session_start(); $_SESSION=['user_email'=>${JSON.stringify(email)},'user_name'=>'Test Owner','user_role'=>'admin']; session_write_close(); $_GET=['folder'=>${JSON.stringify(folder)},'full_house'=>'1','action'=>${JSON.stringify(action)}]; $_SERVER['HTTP_HOST']='php-test.local'; $_SERVER['REQUEST_METHOD']='GET'; include '../measure/internal/editor.php';`;
    const child = spawn(binary, [...extensions, '-d', 'memory_limit=32M', '-r', php], { env: { ...process.env, FIRSTMEASURE_API_BASE: `http://127.0.0.1:${port}/v1/firstmeasure`, FIRSTMEASURE_INTERNAL_API_SECRET: 'test-only-php-secret', FIRSTMEASURE_FULL_HOUSE_SIGNING_SECRET: 'test-full-house-signing-secret' } });
    let html = '', errors = ''; child.stdout.on('data', chunk => html += chunk); child.stderr.on('data', chunk => errors += chunk);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve({ html, errors }) : reject(Error(errors)));
  });
  try {
    const customerId='exteriors_'+'c'.repeat(32);
    const customer=await render(customerId,'technician@example.test');
    assert.match(customer.html,/editor_scripts\/exterior_pdf\.js/);
    assert.match(customer.html,/editor_scripts\/project_resources\.js/);
    await render(customerId,'technician@example.test','project_feedback');
    assert.equal(lastPath,'/v1/firstmeasure/projects/'+customerId+'/editor/feedback');
    const roof = await render('a'.repeat(32));
    assert.match(roof.html, /editor_scripts\/pane_layout\.js/);
    assert.doesNotMatch(roof.html, /editor_scripts\/(?:wall_|exterior_|project_resources|resource_3d_overlay|base_editor|ground_editor)/);
    assert.doesNotMatch(roof.html, /FIRSTMEASURE_FULL_HOUSE = true/);
    const full = await render('fullhouse_' + 'b'.repeat(32));
    assert.match(full.html, /FIRSTMEASURE_FULL_HOUSE = true/);
    assert.match(full.html, /editor_scripts\/wall_mode\.js/);
    assert.match(full.html, /editor_scripts\/project_resources\.js/);
    assert.match(full.html, /editor_scripts\/exterior_pdf\.js/);
    assert.equal((await render('fullhouse_' + 'b'.repeat(32), 'technician@example.test')).html, 'Not found');
    allowed = false;
    assert.equal((await render('fullhouse_' + 'b'.repeat(32))).html, 'Not found');
    assert.match((await render('a'.repeat(32))).html, /editor_scripts\/pane_layout\.js/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
