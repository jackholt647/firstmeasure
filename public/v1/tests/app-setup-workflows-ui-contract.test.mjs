import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const [workflows, core, settings, portalIndex, setupShell] = await Promise.all([
  readFile(path.join(publicRoot, 'libraries/app-setup-workflows/app-setup-workflows.js'), 'utf8'),
  readFile(path.join(publicRoot, 'portal/scripts/core.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8'),
  readFile(path.join(publicRoot, 'portal/index.php'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/setup-wizard/setup-wizard.js'), 'utf8')
]);

function declaredInventory(){
  const window = {
    dispatchEvent(){},
    addEventListener(){},
    Portal:null,
    PlatformAPI:null
  };
  const sandbox = {
    window,
    localStorage:{ getItem(){ return null; }, setItem(){} },
    CustomEvent:class CustomEvent { constructor(type, init){ this.type = type; this.detail = init?.detail; } },
    URL,
    Intl,
    Date,
    console,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(workflows, sandbox, { filename:'app-setup-workflows.js' });
  return window.FirstMateAppSetupWorkflows.inventory();
}

test('the declarative setup layer loads after core and reuses the shared wizard shell', () => {
  const coreIndex = portalIndex.indexOf('scripts/core.js');
  const workflowIndex = portalIndex.indexOf('libraries/app-setup-workflows/app-setup-workflows.js');
  assert.ok(coreIndex >= 0 && workflowIndex > coreIndex);
  assert.match(workflows, /window\.FirstMateSetupWizard\.open\(/);
  assert.match(setupShell, /grid-template-columns:250px minmax\(0,1fr\)/);
  assert.match(setupShell, /@media\(max-width:860px\)/);
  assert.match(workflows, /@media\(max-width:720px\)/);
  assert.match(workflows, /data-fm-wizard\^="app-setup-"\]\{align-items:center;padding:24px\}/);
  assert.match(workflows, /min-height:min\(50dvh,calc\(100dvh - 48px\)\);max-height:min\(780px,calc\(100dvh - 48px\)\)/);
  assert.match(workflows, /data-fm-wizard\^="app-setup-"\]\{align-items:stretch;padding:0\}/);
  assert.match(workflows, /height:100dvh;min-width:0;min-height:0;max-height:none/);
});

test('all audited apps have an explicit required, optional, or no-setup declaration', () => {
  const inventory = declaredInventory();
  assert.equal(inventory.length, 30);
  const byMode = Object.groupBy(inventory, (entry) => entry.mode);
  assert.deepEqual(byMode.required.map((entry) => entry.key).sort(), [
    'apps.crew', 'apps.feedback', 'apps.messaging', 'apps.payroll', 'apps.sales', 'calls.app',
    'platform.lead_import', 'platform.money', 'settings.live_chat'
  ].sort());
  assert.deepEqual(byMode.none.map((entry) => entry.key).sort(), [
    'apps.channels', 'apps.firstmeasure', 'apps.projects', 'apps.referrals', 'apps.stats',
    'canvassing.app', 'platform.project_docs', 'platform.project_photos'
  ].sort());
  assert.equal(byMode.optional.length, 13);
});

test('workflow fields, validation, review, and persistence are generated centrally', () => {
  assert.match(workflows, /function inputMarkup\(definition, values\)/);
  assert.match(workflows, /function validateField\(definition, values\)/);
  assert.match(workflows, /function reviewStep\(definition\)/);
  assert.match(workflows, /function generatedSteps\(definition\)/);
  assert.match(workflows, /MODULE_ID = 'app_setup_workflows'/);
  assert.match(workflows, /PlatformAPI\.branchModules\.save/);
  assert.match(workflows, /visited_steps/);
  assert.match(workflows, /status:recordStatus/);
  assert.match(workflows, /fm:app-setup:updated/);
});

test('required setup auto-launches while optional setup remains user-invoked', () => {
  assert.match(core, /setup\.mode === 'required' && setup\.status !== 'complete'/);
  assert.match(core, /setup\.mode === 'required' \? 'Add & Set Up' : 'Add to Platform'/);
  assert.match(core, /data-app-catalog-setup/);
  assert.match(settings, /Setup in progress/);
  assert.match(settings, /Setup required/);
  assert.match(settings, /Optional setup/);
  assert.match(settings, /window\.Portal\?\.appSetup\?\.run/);
});

test('10DLC and Money remain external adapter-only workflows', () => {
  const inventory = declaredInventory();
  assert.equal(inventory.find((entry) => entry.key === 'apps.messaging')?.external, true);
  assert.equal(inventory.find((entry) => entry.key === 'platform.money')?.external, true);
  assert.match(workflows, /workflow:'10dlc', workflow_step:'business'/);
  assert.doesNotMatch(workflows, /setup\.register\('platform\.money'/);
  assert.doesNotMatch(workflows, /DomainsAPI|domain_onboarding|money_onboarding/);
  assert.match(core, /workflow: 'money_onboarding', workflow_step: 'business'/);
});

test('app setup routing stays inside Portal.navigation', () => {
  assert.match(workflows, /navigation\?\.navigate\?\./);
  assert.match(workflows, /navigation\?\.registerHandler\?\./);
  assert.doesNotMatch(workflows, /history\.(?:pushState|replaceState)/);
  assert.doesNotMatch(workflows, /new URLSearchParams/);
});

test('feedback setup is a paginated delivery, message, and feedback-flow workflow', () => {
  const feedback = declaredInventory().find((entry) => entry.key === 'apps.feedback');
  assert.deepEqual(Array.from(feedback.steps), ['delivery', 'messages', 'workflow']);
  assert.match(workflows, /renderFeedbackDeliveryStep/);
  assert.match(workflows, /renderFeedbackMessagesStep/);
  assert.match(workflows, /data-feedback-setup-insight/);
  assert.match(workflows, /Scope-aware timing is still being connected/);
  assert.match(workflows, /fm-feedback-preview/);
  assert.doesNotMatch(workflows, /step\('activate', 'Activate', 'Turn on feedback collection'/);
});

test('feedback timing has no workflow-step button and keeps scope timing as an explicit TODO', () => {
  assert.doesNotMatch(workflows, /option\('workflow','At a workflow step'/);
  assert.match(workflows, /TODO\(feedback-scope-timing\)/);
});
