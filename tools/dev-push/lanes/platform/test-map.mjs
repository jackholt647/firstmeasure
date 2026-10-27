// Which tests the platform gate runs for a change (docs/architecture/dev-lanes.md). Paths are repo-relative.
// Areas come from AGENTS.md ("Run tests/X for changes here"); keep the two in step when either changes.
// `v1:` tests run from public/v1 with tsx; `root:` tests run from the repository root with node --test.

const V1 = "public/v1/";
const LIB = "public/libraries/";

/** [path prefixes or regexes, tests] */
export const AREAS = [
  [[`${V1}platform/security/`, `${V1}firstmeasure/access.ts`, /^public\/v1\/.*\/api\.ts$/], ["v1:tests/route-access.test.ts"]],
  [["tools/live-layer/", `${LIB}live-assets/`, `${V1}platform/live_assets.ts`], ["root:tests/live-layer.test.mjs"]],
  [["tools/frontend-bridge/"], ["root:tests/frontend-bridge.test.mjs"]],
  [["tools/dev-push/"], ["root:tests/dev-push-router.test.mjs"]],
  [[`${V1}forms/`, `${LIB}forms-api/`, `${LIB}forms-embed/`, `${LIB}forms-staff/`, `${LIB}apps/settings/forms.js`], ["v1:tests/forms-api.test.ts"]],
  [[`${V1}documents/inputs.ts`, `${V1}documents/render.ts`, `${LIB}doc-sent-editor/`], ["v1:tests/document-as-sent-editing.test.ts"]],
  [[`${V1}platform/app-experience/`, `${LIB}apps/firstmate-apps-manifest.js`], ["v1:tests/app-experience.test.ts", "v1:tests/app-experience-registry.test.ts", "v1:tests/access-gates.test.ts"]],
  [[`${V1}payments/`, `${V1}payment-browser/`, `${LIB}payments-api/`, `${LIB}payments-setup/`, `${LIB}payment-intake/`], ["v1:npm:test:payments"]],
  [[`${V1}contacts/`, `${V1}leads/`, `${V1}projects/`, `${V1}lead-intake/`], ["v1:tests/contacts-store.test.ts", "v1:tests/contact-merge.test.ts", "v1:tests/lead-receive.test.ts", "v1:tests/new-leads.test.ts", "v1:tests/project-entry.test.ts"]],
  [[`${V1}platform/publication/`], ["v1:npm:test:publication"]],
  [[`${V1}platform/publication/measurement-schemas.ts`], ["v1:tests/publication-measurement-schemas.test.ts"]],
  [[`${V1}crm/`, `${LIB}apps/crm/`], ["v1:tests/crm-views.test.ts", "v1:tests/crm-rescission.test.ts"]],
  [[`${V1}labor/completion.ts`, `${V1}closeout/`], ["v1:tests/labor-completion.test.ts"]],
  [[`${V1}labor/pay-sheets.ts`], ["v1:tests/labor-pay-sheets.test.ts"]],
  [[`${V1}payroll/`, `${LIB}payroll-api/`], ["v1:tests/pay-rules.test.ts", "v1:tests/pay-sources.test.ts"]],
  [[`${V1}labor/commitments`], ["v1:tests/labor-commitments.test.ts"]],
  [[`${V1}assignees/`, `${V1}labor/capabilities.ts`], ["v1:tests/assignee-base.test.ts", "v1:tests/assignee-roster.test.ts", "v1:tests/assignee-base-store.test.ts"]],
  [[`${V1}workforce/branches.ts`, `${V1}workforce/organization-structure.ts`], ["v1:tests/branches.test.ts", "v1:tests/organization-structure.test.ts"]],
  [[`${V1}platform/publication/work-items.ts`], ["v1:tests/work-requirements.test.ts"]],
  [[`${V1}history/`], ["v1:tests/project-history.test.ts"]],
  [[`${V1}documents/versions/`, `${V1}documents/signing/`, `${V1}documents/storage.ts`], ["v1:tests/documents-versions.test.ts", "v1:tests/document-signing.test.ts"]],
  [[`${V1}scheduling/`, `${V1}appointments/`], ["v1:tests/schedule-events.test.ts", "v1:tests/scheduling-event-writes.test.ts"]],
  [[`${V1}work/conditions.ts`, `${V1}work/automations/`, `${V1}scopes/instances.ts`], ["v1:tests/automation-contracts.test.ts"]],
  [[`${V1}agents/how-tos/`], ["v1:tests/agent-how-to-index.test.ts"]],
  [[`${V1}guided-experiences/`, `${LIB}guided-experiences/`, `${LIB}setup-steps/`, `${LIB}tab-guides/`], ["v1:tests/setup-steps.test.ts", "v1:tests/guided-experiences.test.ts", "v1:tests/guided-experiences-dev.test.ts", "v1:tests/guided-tab-tours.test.ts"]],
  [[`${V1}pricebook/`], ["v1:tests/pricebook-roofing-setup.test.ts"]],
  [[/^public\/v1\/platform\/realtime/, `${LIB}platform-realtime/`], ["v1:tests/realtime-single-stream.test.ts"]],
  [[`${V1}session-replay/`, `${LIB}session-replay/`], ["v1:tests/session-replay.test.ts", "v1:tests/session-replay-archive.test.ts", "v1:tests/session-replay-agent-access.test.ts"]],
  [[`${V1}platform/localization/`, `${LIB}platform-language/`], ["v1:cmd:localization-check"]]
];

/** Cheap checks that need no test file: what `cmd:` ids run, from public/v1. */
export const COMMANDS = {
  "localization-check": ["node", "scripts/localization-catalogs.mjs", "--check"]
};

const matches = (file, pattern) => (typeof pattern === "string" ? file === pattern || file.startsWith(pattern) : pattern.test(file));

/** Test ids for a set of changed paths, plus any test files changed directly and tests named in manifests. */
export function testsFor(changed, requested = []) {
  const ids = new Set();
  for (const file of changed) {
    for (const [patterns, tests] of AREAS) if (patterns.some((pattern) => matches(file, pattern))) tests.forEach((id) => ids.add(id));
    let match;
    if ((match = /^public\/v1\/(tests\/[^/]+\.test\.(?:ts|mjs))$/.exec(file))) ids.add(`v1:${match[1]}`);
    else if ((match = /^(tests\/[^/]+\.test\.mjs)$/.exec(file))) ids.add(`root:${match[1]}`);
  }
  for (const test of requested) {
    const clean = String(test).replace(/\\/g, "/").replace(/^\.\//, "");
    if (/^(v1|root):/.test(clean)) ids.add(clean);
    else if (clean.startsWith("public/v1/")) ids.add(`v1:${clean.slice(V1.length)}`);
    else ids.add(`any:${clean.startsWith("tests/") ? clean : `tests/${clean}`}`); // public/v1/tests if it exists there, else the root's
  }
  return [...ids].sort();
}
