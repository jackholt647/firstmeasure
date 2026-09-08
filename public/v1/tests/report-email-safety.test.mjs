// Runs the compiled report sender with a captured transport: no email or token access.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '../../outputs/email-guard-build');
const api = await readFile(path.join(root, 'firstmeasure/api.js'), 'utf8');
assert.match(api, /import \{ guardDevelopmentEmail \} from "..\/src\/environment_safety.js"/);
const start = api.indexOf('async function sendPostmarkEmail(');
const end = api.indexOf('async function readPostmarkToken(', start);
assert.ok(start >= 0 && end > start);
const sender = api.slice(start, end);
const guardSource = (await readFile(path.join(root, 'src/environment_safety.js'), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const base = { dataEnvironmentExplicit: true, dataEnvironment: 'development',
  developmentEmailAllowedDomains: ['1m8.ai'], developmentEmailMode: 'rewrite',
  developmentEmailCatchall: 'support@1m8.ai' };
const attachment = { Name: 'test.pdf', Content: 'JVBERi0=', ContentType: 'application/pdf' };
let passed = 0;
async function check({ to, expectedTo, env = base, disabled, guard, blocked = false }) {
  const calls = [];
  let tokenReads = 0;
  const context = vm.createContext({ env, process: { env: { EMAIL_OUTBOUND_DISABLED: disabled } },
    readPostmarkToken: async () => { tokenReads++; return 'fake-test-token'; },
    wrapEmailText: x => x, wrapEmailHtml: x => x, escapeHtml: x => x,
    fetch: async (url, options) => { calls.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ErrorCode: 0 }) }; } });
  vm.runInContext(guardSource + '\n' + sender, context);
  if (guard) context.guardDevelopmentEmail = guard;
  context.input = { to, subject: 'Roof Report - test', textBody: 'Test', attachments: [attachment] };
  const result = await vm.runInContext('sendPostmarkEmail(input)', context);
  assert.equal(result.ok, !blocked);
  if (blocked) { assert.equal(calls.length, 0); assert.equal(tokenReads, 0); }
  else {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].To, expectedTo);
    assert.deepEqual(calls[0].Attachments, [attachment]);
    assert.equal('Cc' in calls[0] || 'Bcc' in calls[0], false);
    if (expectedTo === 'support@1m8.ai' && to.includes('example.com')) {
      assert.match(calls[0].Subject, /^\[DEV intended for /);
    }
  }
  passed++;
}
await check({to:'customer@example.com',expectedTo:'support@1m8.ai'});
await check({to:'qa@1m8.ai',expectedTo:'qa@1m8.ai'});
await check({to:'qa@1m8.ai,customer@example.com',expectedTo:'support@1m8.ai'});
await check({to:'customer@example.com,other@example.com',expectedTo:'support@1m8.ai'});
await check({to:'qa@1m8.ai,staff@1m8.ai',expectedTo:'qa@1m8.ai,staff@1m8.ai'});
await check({to:'customer@example.com',env:{...base,developmentEmailMode:'block',developmentEmailCatchall:''},blocked:true});
await check({to:'customer@example.com',env:{...base,dataEnvironment:'production'},expectedTo:'customer@example.com'});
for (const disabled of ['1','true']) await check({to:'qa@1m8.ai',disabled,blocked:true});
for (const to of ['', 'customer@example.com;qa@1m8.ai', 'bad@outside@1m8.ai']) await check({to,blocked:true});
if (process.env.FIRSTMEASURE_DATA_ENVIRONMENT === 'development') {
  const { guardDevelopmentEmail } = await import(pathToFileURL(path.join(root,'src/environment_safety.js')));
  assert.equal(process.env.DEVELOPMENT_EMAIL_CATCHALL, 'support@1m8.ai');
  await check({to:'customer@example.com,qa@1m8.ai',expectedTo:'support@1m8.ai',guard:guardDevelopmentEmail});
}
console.log(`PASS: ${passed} report email safety checks; transport mocked, no mail sent.`);
