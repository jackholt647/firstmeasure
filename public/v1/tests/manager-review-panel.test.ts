import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../measure/internal/portal_scripts/manager_review.js", import.meta.url), "utf8");
const categories = source.slice(source.indexOf("  const ISSUE_CATEGORIES="), source.indexOf("\n", source.indexOf("  const ISSUE_CATEGORIES=")));
const render = source.slice(source.indexOf("  function renderInfoPanel(){"), source.indexOf("  async function submitReview"));
const submit = source.slice(source.indexOf("  async function submitReview"), source.indexOf("  async function markReviewed"));
const escapeHtml = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

class Element {
  html = "";
  value = "";
  disabled = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  classes = new Set<string>();
  onclick?: () => unknown;
  onHtml?: (html: string) => void;
  classList = { toggle: (name: string) => {
    if (this.classes.has(name)) { this.classes.delete(name); return false; }
    this.classes.add(name); return true;
  } };
  set innerHTML(html: string) { this.html = html; this.onHtml?.(html); }
  get innerHTML() { return this.html; }
  addEventListener(_event: string, listener: () => unknown) { this.onclick = listener; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  querySelectorAll(_selector: string): Element[] { return []; }
}

function panel(storedSeverity?: string, selected = ["missing_structure"], saveAnnotations: () => Promise<boolean> = async () => true) {
  const elements = new Map<string, Element>();
  const getElementById = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  let categoryButtons: Element[] = [], severityButtons: Element[] = [];
  const actions = getElementById("mraBiActions");
  actions.onHtml = html => {
    // Parse actual rendered controls instead of duplicating their defaults.
    const parseButtons = (attribute: string) => [...html.matchAll(/<button\b([^>]*)>/g)].flatMap(match => {
      const attrs = Object.fromEntries([...match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(attr => [attr[1]!, attr[2]!]));
      if (!attrs[`data-${attribute}`]) return [];
      const button = new Element(); button.attrs = attrs;
      button.dataset[attribute] = attrs[`data-${attribute}`]!;
      button.classes = new Set((attrs.class || "").split(" "));
      return [button];
    });
    categoryButtons = parseButtons("category"); severityButtons = parseButtons("severity");
    getElementById("mraReviewSeverity").value = html.match(/id="mraReviewSeverity" value="([^"]*)"/)?.[1] || "";
  };
  actions.querySelectorAll = selector => selector === ".mra-category-btn" ? categoryButtons : selector === ".mra-severity-btn" ? severityButtons : [];
  const calls: unknown[][] = [];
  const project = { id: "test-id", address: 'Long address <script> & "name"', status: "completed", manager_audit_severity: storedSeverity, manager_audit_issue_categories: selected };
  const context = vm.createContext({
    document: { getElementById, querySelectorAll: (selector: string) => selector === "#mraBiActions .mra-category-btn.selected" ? categoryButtons.filter(button => button.classes.has("selected")) : [] },
    navigator: {}, window: {}, currentProject: project,
    currentManifest: {}, currentProjectIdx: 0, displayProjects: [project], resultsLoaded: true,
    esc: escapeHtml, fmtShort: () => "Sep 9", wireReviewImageUpload() {}, renderReviewImagePreviews() {},
    commitAnnotText() {}, doSaveAnnotations: saveAnnotations, uploadPendingReviewImages: async () => [],
    markAudit: async (...args: unknown[]) => { calls.push(args); return { success: true }; },
    rederiveTech() {}, advanceToNext() {}, alert(message: string) { throw new Error(message); }
  });
  vm.runInContext(categories + "\n" + render + "\n" + submit + "\nrenderInfoPanel();", context);
  return { getElementById, categoryButtons, severityButtons, calls, project, context };
}

test("compact QA Quality panel retains category identities and accessible toggle state", () => {
  const fixture = panel("minor");
  const html = fixture.getElementById("mraBiActions").innerHTML;
  assert.deepEqual(fixture.categoryButtons.map(button => button.dataset.category), ["missing_section", "missing_structure", "missing_skylight_chimney", "wrong_shapes_or_tracing", "wrong_line_types", "didnt_follow_customer_notes"]);
  assert.equal(fixture.categoryButtons[1]!.attrs["aria-pressed"], "true");
  assert.match(html, /mra-review-buttons[^]*mraSubmitReview[^]*mraBiEditor/);
  assert.match(fixture.getElementById("mraBiInner").innerHTML, /title="Long address &lt;script> &amp; &quot;name&quot; · Click to copy"/);
  fixture.categoryButtons[0]!.onclick!(); assert.equal(fixture.categoryButtons[0]!.attrs["aria-pressed"], "true");
  fixture.categoryButtons[1]!.onclick!(); assert.equal(fixture.categoryButtons[1]!.attrs["aria-pressed"], "false");
});

for (const [stored, expected] of [[undefined, "major"], ["minor", "minor"], ["major", "major"]] as const) {
  test(`severity buttons initialize ${stored || "unset"} as ${expected} and remain mutually exclusive`, () => {
    const fixture = panel(stored);
    const selected = () => fixture.severityButtons.filter(button => button.attrs["aria-pressed"] === "true").map(button => button.dataset.severity);
    assert.deepEqual(selected(), [expected]);
    assert.equal(fixture.getElementById("mraReviewSeverity").value, expected);
    for (const severity of ["minor", "major", "major", "minor"]) {
      fixture.severityButtons.find(button => button.dataset.severity === severity)!.onclick!();
      assert.deepEqual(selected(), [severity], "exactly one selection remains, including repeated clicks");
      assert.equal(fixture.getElementById("mraReviewSeverity").value, severity);
    }
  });
}

for (const severity of ["minor", "major", null]) {
  test(`actual submitReview sends ${severity || "null for no issues"} severity`, async () => {
    const fixture = panel(severity === "minor" ? "major" : "minor", severity === null ? [] : ["missing_structure"]);
    if (severity) fixture.severityButtons.find(button => button.dataset.severity === severity)!.onclick!();
    fixture.getElementById("mraReviewNote").value = "  review note  ";
    await fixture.getElementById("mraSubmitReview").onclick!();
    assert.equal(fixture.calls.length, 1);
    const [id, status, note, payload, timeout] = fixture.calls[0]!;
    assert.equal(id, "test-id"); assert.equal(status, severity ? "flagged" : "reviewed");
    assert.equal(note, "review note"); assert.equal(timeout, 15000);
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), { issue_categories: severity ? ["missing_structure"] : [], attachments: [], severity });
    assert.equal(fixture.project.manager_audit_severity, severity, "the cached project matches the accepted payload");
    vm.runInContext("renderInfoPanel();", fixture.context);
    assert.equal(fixture.getElementById("mraReviewSeverity").value, severity || "major", "revisiting the project keeps the saved severity; a pass defaults to major if later flagged");
  });
}

test("severity is captured at submit time, not changed while annotations save", async () => {
  let finishSave: (result: boolean) => void = () => {};
  const saving = new Promise<boolean>(resolve => { finishSave = resolve; });
  const fixture = panel("minor", ["missing_structure"], () => saving);
  const pending = fixture.getElementById("mraSubmitReview").onclick!();
  fixture.severityButtons.find(button => button.dataset.severity === "major")!.onclick!();
  finishSave(true);
  await pending;
  assert.equal(fixture.calls.length, 1);
  assert.equal((fixture.calls[0]![3] as { severity: string }).severity, "minor");
  assert.equal(fixture.project.manager_audit_severity, "minor");
});
