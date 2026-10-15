import type { HowToEntry } from "../types.js";

// Steps 1 and 2 read the project change history (docs/architecture/project-history.md), exercised in
// tests/project-history.test.ts. Step 4c waits on a published way to edit a document template's material calculation.
export const improveGenerationFromHistory: HowToEntry = {
  id: "improve_generation_from_history",
  title: "Improve automatic generation from what people keep changing",
  use_when: "The user wants generated material lists, work orders or scope lists to need fewer manual fixes, or asks what people usually change after generation.",
  keywords: ["automation", "pattern", "manual changes", "edits", "learn", "history", "generated", "material list", "starter strip", "pay sheet", "template", "improve"],
  steps: [
    {
      title: "Read what people did to each generation",
      detail: "platform_read project-history.generation-outcomes on an organization target with args {generator, edited_only:true, since} (limit up to 500). generator is labor.pay_sheet (work orders priced on a pay sheet), materials.calculus (material a signed document's calculation made) or scope.resources (lists a scope built). Each row has inputs (what the generator was given), generator_version (the sheet, calculation or template version used) and outcome: added (lines people put beside it), removed and changed (each field before and after), edited_by. Read every generator the request touches.",
      refs: { data: ["project-history.generation-outcomes"] }
    },
    {
      title: "Find a change that follows from the inputs",
      detail: "Group outcome lines by what was done: the same product or line name added, removed, or a field changed the same way. For each group, count the runs where it happened against the runs that share a candidate condition in inputs: a product in inputs.materials or inputs.document (shingle line, colour, variant), a measurement in inputs.measurements, a project field in inputs.fields, the assignee or pay sheet. Keep a pattern only when the condition holds in most runs where the change happened and the change happens in most runs with the condition, over at least five runs. Ignore runs on an older generator_version than the current one when the newer version already does it. Read project-history.changes for a project when the order of edits matters.",
      refs: { data: ["project-history.changes"] }
    },
    {
      title: "Ask before changing anything",
      detail: "Tell the user each pattern in one sentence with its counts, for example: \"On 9 of 11 jobs with Presidential shingles someone added a second box of starter strip; on jobs without them, 1 of 30.\" Ask whether it is on purpose and whether to always do it. Change nothing for a pattern the user does not confirm, and nothing from a single project."
    },
    {
      title: "Change a pay sheet (labor.pay_sheet)",
      detail: "Read the sheet with platform_read pay-sheets.catalog, add or change the pay entry, input or equipment that matches the pattern, and save the whole sheet with platform_invoke pay-sheets.sheet.save. Check it with pay-sheets.evaluation on a project the pattern came from: the lines should now include what people were adding.",
      refs: { data: ["pay-sheets.catalog", "pay-sheets.evaluation"], actions: ["pay-sheets.sheet.save"] }
    },
    {
      title: "Change a scope's lists (scope.resources)",
      detail: "Read the scope template, change resources.lists[].items or the list definitions that match the pattern, and save the whole template. A template save affects new projects only.",
      refs: { tools: ["scope.read_scope_template", "scope.save_scope_template"] }
    },
    {
      title: "Change a document's material calculation (materials.calculus)",
      detail: "Intended: change the calculation the document template runs so its lines include what people were adding, keyed by the same input.",
      planned: "Editing a document template's material calculation is not published to agents yet. Report the confirmed pattern to the user so a person can change the template."
    },
    {
      title: "Confirm on the next jobs",
      detail: "After the change, read project-history.generation-outcomes again for runs on the new generator_version. The pattern should stop appearing in outcome.added; if people now remove what was added, the condition was wrong. Say so and offer to revert.",
      refs: { data: ["project-history.generation-outcomes"] }
    }
  ],
  notes: [
    "An outcome counts only what people did before the same list was generated again, and leaves out lines another generator made.",
    "A change with source.tool set (such as requirements.fix_all) was made by an interface tool for a person; treat it as automatic, not as a person's correction.",
    "Never change a generator because of one project, and never without the user confirming the pattern.",
    "Say \"assignee\" in anything shown to the user. What a group is called comes from the terminology system."
  ]
};
