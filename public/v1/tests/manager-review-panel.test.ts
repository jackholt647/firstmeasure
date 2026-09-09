import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../measure/internal/portal_scripts/manager_review.js", import.meta.url), "utf8");
const categories = source.slice(source.indexOf("  const ISSUE_CATEGORIES="), source.indexOf("\n", source.indexOf("  const ISSUE_CATEGORIES=")));
const render = source.slice(source.indexOf("  function renderInfoPanel(){"), source.indexOf("  async function submitReview"));

test("compact QA Quality panel retains category identities, accessible toggle state, and stored severity", () => {
  const elements = new Map<string, { innerHTML: string; onclick?: () => void; addEventListener: () => void; querySelectorAll: () => unknown[] }>();
  const buttons: { attrs: Record<string, string>; click?: () => void; classList: { toggle: () => boolean }; setAttribute: (key: string, value: string) => void; addEventListener: (_event: string, listener: () => void) => void }[] = [];
  const getElementById = (id: string) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", addEventListener() {}, querySelectorAll() { return buttons; } });
    return elements.get(id)!;
  };
  for (let i = 0; i < 6; i++) {
    let selected = i === 1;
    buttons.push({ attrs: {}, classList: { toggle: () => selected = !selected }, setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(_event, listener) { this.click = listener; } });
  }
  const context = vm.createContext({
    document: { getElementById }, navigator: {}, window: {},
    currentProject: { id: "test-id", address: "Long address <script> & \"name\"", status: "completed", manager_audit_severity: "minor", manager_audit_issue_categories: ["missing_structure"] },
    currentManifest: {}, currentProjectIdx: 0, displayProjects: [{}],
    esc: (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    fmtShort: () => "Sep 9", wireReviewImageUpload() {}, renderReviewImagePreviews() {}
  });
  vm.runInContext(categories + "\n" + render + "\nrenderInfoPanel();", context);
  const html = getElementById("mraBiActions").innerHTML;
  assert.deepEqual([...html.matchAll(/data-category="([^"]+)"/g)].map(match => match[1]), ["missing_section", "missing_structure", "missing_skylight_chimney", "wrong_shapes_or_tracing", "wrong_line_types", "didnt_follow_customer_notes"]);
  assert.match(html, /aria-pressed="true" data-category="missing_structure"/);
  assert.match(html, /value="minor" selected/);
  assert.match(html, /mra-review-buttons[^]*mraSubmitReview[^]*mraBiEditor/);
  assert.match(getElementById("mraBiInner").innerHTML, /title="Long address &lt;script> &amp; &quot;name&quot; · Click to copy"/);
  buttons[0]!.click!(); assert.equal(buttons[0]!.attrs["aria-pressed"], "true");
  buttons[1]!.click!(); assert.equal(buttons[1]!.attrs["aria-pressed"], "false");
});
