/**
 * One-off: configure the notifications@1m8.ai test org for the documents
 * consolidation — document engine on, New button in selector mode offering
 * New Proposal / New Invoice / New Document alongside the classic actions.
 *
 *   node --experimental-sqlite --import tsx scripts/configure-docs-test-org.ts
 */
import { saveCapabilityValues, effectiveCapabilities } from "../platform/capabilities.js";
import "../platform/capability_defs.js";

const ORG_ID = process.env.ORG_ID || "06a71ab1357a7a41aa6ee80a";

const { violations } = await saveCapabilityValues(ORG_ID, {
  "platform.documents": true,
  "documents.templates_studio": true,
  "documents.workflow_authoring": true,
  "documents.theme_authoring": true,
  "documents.esign": true,
  "platform.new_button_mode": "selector",
  "platform.new_button_items": "project,contact,report,document,doc:proposal,doc:invoice,payment,appointment"
});
if (violations.length) console.log("violations:", JSON.stringify(violations, null, 2));
const effective = await effectiveCapabilities(ORG_ID) as any;
console.log("resolution keys:", Object.keys(effective));
for (const key of ["platform.documents", "documents.templates_studio", "documents.workflow_authoring", "documents.theme_authoring", "platform.project_docs", "platform.new_button_mode", "platform.new_button_items", "platform.proposals"]) {
  console.log(key, "raw=", JSON.stringify(effective.values?.[key]), "effective=", JSON.stringify(effective.effectiveByKey?.[key]));
}
console.log("done for org", ORG_ID);
