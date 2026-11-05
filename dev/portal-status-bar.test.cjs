const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SOURCE = fs.readFileSync('public/measure/internal/portal_scripts/portal_status_bar.js', 'utf8');

function bar(user, snapshot) {
  const mount = { innerHTML: '', style: {}, querySelectorAll: () => [] };
  const document = {
    readyState: 'complete', hidden: false, head: { appendChild() {} },
    getElementById: id => (id === 'portalStatusBarMount' ? mount : null),
    createElement: () => ({}), addEventListener() {}
  };
  const context = {
    document, console, setInterval: () => 1, clearInterval() {}, setTimeout,
    PORTAL_CFG: { user: { training_complete: true, ...user.user }, perms: user.perms || {}, flags: user.flags || {}, endpoints: { server: 'server.php' } },
    Portal: {
      fmPost: async () => snapshot,
      apiPost: async (_endpoint, body) => (body.action === 'rush_mode_current' ? { active: false } : snapshot)
    }
  };
  context.window = context;
  vm.runInNewContext(SOURCE, context);
  return { mount, statusBar: context.PortalStatusBar };
}

// init() starts the first refresh; wait for it to render.
async function settled(statusBar) {
  for (let i = 0; i < 20 && (statusBar.state.loading || !statusBar.state.snapshot); i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function chipValue(html, label) {
  const match = html.match(new RegExp(`<span class="portal-status-label">${label}</span>\\s*<span class="portal-status-value">([^<]*)</span>`));
  assert.ok(match, `${label} chip is rendered`);
  return match[1];
}

const manager = { user: { is_admin: true } };

test('manager Avg shows -- when nothing completed in the lookback, not 0m', async () => {
  const { mount, statusBar } = bar(manager, {
    success: true, status_counts: [], average_completion_ms: null, average_completion_count: 0, warning_count: 0
  });
  await settled(statusBar);
  assert.equal(chipValue(mount.innerHTML, 'Avg'), '--');
  assert.doesNotMatch(mount.innerHTML, /portal-status-chip--good/);
});

test('manager Avg shows the server average when there is one', async () => {
  const { mount, statusBar } = bar(manager, {
    success: true, status_counts: [], average_completion_ms: 47 * 60000, average_completion_count: 12, warning_count: 0
  });
  await settled(statusBar);
  assert.equal(chipValue(mount.innerHTML, 'Avg'), '47m');
  assert.match(mount.innerHTML, /portal-status-chip--good/);
});

test('technician and QA averages without a value show --', () => {
  const { mount, statusBar } = bar({ user: {} }, {});
  statusBar.renderTechnicianBar({ stats: { technician: { average_work_ms: null } }, shift: {} });
  assert.equal(chipValue(mount.innerHTML, 'Avg Work'), '--');
  statusBar.renderQaBar({ stats: { qa: { average_decision_ms: null } }, shift: {} });
  assert.equal(chipValue(mount.innerHTML, 'Avg Decision'), '--');
  assert.equal(statusBar.durationMs(undefined), null);
  assert.equal(statusBar.durationMs(''), null);
  assert.equal(statusBar.durationMs(0), 0);
  assert.equal(statusBar.durationMs('90000'), 90000);
});
