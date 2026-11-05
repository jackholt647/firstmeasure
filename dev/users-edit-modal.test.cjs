// FM-342: the Users tab's Edit button must open the permissions modal for every
// user, whatever their record holds. It used to inline JSON.stringify(user) in
// an onclick attribute; a Gmail signature with &quot; was decoded inside the
// attribute, broke the script and the click did nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SOURCE = fs.readFileSync('public/measure/internal/portal_scripts/users.js', 'utf8');

function element(extra = {}) {
  return {
    innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    dataset: {}, style: {}, children: [], listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
    appendChild(child) { this.children.push(child); return child; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    ...extra
  };
}

function row() {
  const button = element();
  return Object.assign(element(), {
    button,
    querySelector(selector) {
      assert.equal(selector, '.user-edit-btn');
      return this.innerHTML.includes('user-edit-btn') ? button : null;
    }
  });
}

function loadUsers() {
  const table = element({ innerHTML: '' });
  const context = {
    console: { log() {}, warn() {}, error() {}, table() {} },
    performance: { now: () => 0 },
    PORTAL_CFG: { flags: {}, perms: {}, user: {}, endpoints: {} },
    Portal: {
      escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
      qsa: () => []
    },
    document: {
      getElementById: id => (id === 'usersTable' ? table : null),
      createElement: () => row()
    }
  };
  context.window = context;
  vm.runInNewContext(SOURCE, context);
  const Users = context.Users;
  Users.renderTeamStats = () => {};
  Users.teamOptionsHtml = () => '';
  return { Users, table };
}

test('users table never inlines user data into an onclick handler', () => {
  assert.doesNotMatch(SOURCE, /on\w+\s*=\s*('[^']*|"[^"]*)JSON\.stringify/,
    'serialize nothing into inline handlers: HTML entities in the data break them');
});

test('Edit opens the modal for a user whose signature holds &quot; (FM-342)', () => {
  const { Users, table } = loadUsers();
  const ben = {
    id: 'u_ben', email: 'ben@1m8.ai', name: "Ben O'Neil", role: 'admin', account_type: 'employee',
    training_complete: true, team_id: '', permissions: { manage_qa: true },
    integrations: { gmail: { signature_html: '<div style="font-family:Arial">Ben &quot;FirstMate&quot; &amp; co</div>' } }
  };
  Users.allUsers = [ben];
  Users.selectedTeamId = '__all_users__';
  Users.searchTerm = '';
  const opened = [];
  Users.openUserModal = (mode, user) => opened.push({ mode, user });

  Users.renderUsersTable();

  assert.equal(table.children.length, 1);
  const tr = table.children[0];
  assert.doesNotMatch(tr.innerHTML, /onclick=/i);
  assert.ok(tr.button.listeners.click, 'Edit button has a click listener');
  tr.button.listeners.click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].mode, 'edit');
  assert.equal(opened[0].user, ben, 'the modal gets the row user object itself');
});
