# Agent how-to index

Agents can discover single capabilities: published data and actions through
`platform_search`, automations through `get_automation_catalog`, their own tools
through their manifest. The how-to index tells them how to combine those into a
business task. It is a platform-level list of short recipes, checked into
source, that an agent fetches when it needs one.

It is not a fifth instruction layer. The [instruction layers](global-assistant.md#instruction-layers)
say how an agent behaves; a how-to says which registered pieces accomplish a
task and in what order. A how-to grants nothing: every tool and operation it
names is still checked against the current user when the agent calls it.

## Where entries live

`public/v1/agents/how-tos/`

- `types.ts` is the entry contract.
- `entries/<id>.ts` holds one entry per file, as a typed object.
- `index.ts` lists the entries and holds search, read and the prompt index.
- `validate.ts` checks entries against the live registries.

Entries are TypeScript data beside the shared agent runtime for the same
reasons the agent manifests and `work/automations/catalog.ts` are: they describe
code, so they version, review and deploy with it; `npm run check` types them;
and a test can compare them with the registries in the same process. They are
platform-wide, so they do not belong in tenant storage or in an editable
instruction record. One file per entry keeps concurrent edits apart.

## An entry

```ts
export const payForProjectRole: HowToEntry = {
  id: "pay_for_project_role",            // stable snake_case; never renamed or reused
  title: "Pay someone for a role they played on a project",
  use_when: "The user wants ...",        // one line
  keywords: ["commission", "bonus"],     // search words not in the title
  steps: [
    { title: "...", detail: "...", refs: { field_types: ["organization_user"], tools: ["scope.save_scope_template"] } },
    { title: "...", detail: "...", planned: "Pay rules that read a project field do not exist yet." }
  ],
  notes: ["..."]
};
```

`refs` names every id the step relies on:

| Kind | Meaning | Checked against |
| --- | --- | --- |
| `automations` | work automation id | the automation registry and `work/automations/catalog.ts` |
| `events` | work event name | `work/events.ts` |
| `data` | `<provider>.<export>` | `platform/publication/providers.ts` |
| `actions` | published action id | `platform/publication/actions.ts` |
| `field_types` | custom field type | `custom_fields/contracts.ts` |
| `tools` | `platform_x`, or `<agent id>.<tool>` for an agent's own tool | `agents/platform_tools.ts` and the agent registry |

A step with `planned` is not built yet. Its value is one sentence saying what is
missing. Its refs are not checked, and the read tool returns it with
`status: "planned"`, `unavailable: true` and a warning placed before the step
text. Remove `planned` in the same change that builds the step; the check then
starts holding its refs to the registries.

Write for an agent: exact ids, exact input shapes, no narrative. The limits in
`validate.ts` (eight steps, 900 characters of detail per step, five notes) keep
an entry short. Say "assignee", never "crew" ([assignees](assignees.md)).

## How agents reach it

Two tools in `agents/platform_tools.ts`, alongside `platform_search` and the
other shared platform tools, so every human-initiated agent that has platform
tools gets them and focused entry points with `platformTools: false` do not:

- `platform_how_to_search` takes an optional `query` and returns id, title,
  use-when line and step counts. An empty query lists everything.
- `platform_how_to_read` takes an `id` and returns the steps and notes. For the
  current caller it also reports `unavailable_to_you` (published data or actions
  the user's grants or the agent's restrictions hide, using the same discovery
  check as `platform_describe`) and `tools_of_another_agent` (a step that needs,
  say, the Automations Agent's template tools when the assistant is reading).

Both require a current human user and rebuild the publication context from
current membership, like the other platform tools.

`platformAgentInstructions` ends with `howToPromptIndex()`: one instruction and
one `id: title` line per entry. Bodies never go in a system prompt. The test
fails if any step text, note or use-when line appears there.

## Adding an entry

1. Verify the recipe against the code, not from memory. Run it if you can.
2. Add `entries/<id>.ts` and list it in `HOW_TO_ENTRIES` in `index.ts`.
3. Give every available step its `refs`. Mark a step `planned` only when the
   thing it needs does not exist, and say what is missing.
4. Where a recipe depends on behavior that is easy to break, add a case to
   `tests/agent-how-to-index.test.ts` that runs it, as the first entry does.
5. Run the checks below.

## Verification

From `public/v1`:

```
npm run check
node --experimental-sqlite --import tsx --test --test-force-exit tests/agent-how-to-index.test.ts
```

The test fails when an entry is malformed, when an available step names an
automation, event, data export, action, field type or tool that is not
registered, when a body leaks into the prompt, or when a planned step is not
labelled unavailable. Run `npm run test:assistant` as well when changing the
tools or the prompt index.

## What the first entry established

`pay_for_project_role` was checked against the engine before it was written:

- Call-log events (`communication.call.ended`, `communication.call.wrap_up_saved`)
  are rows in `customer_call_events` and never reach the Work engine. The work
  event is `call.completed`, emitted for the project with
  `context.actor_user_id`. Because it names no scope or work item, a binding
  keyed `call.completed` does not run; organization rules and
  `external_triggers` do. A trigger completes its work item as that actor, so an
  `onCompleted` binding can read `{{event.context.actor_user_id}}`.
- `project.event_scheduled` carries no actor. A field that follows an
  appointment uses `default_from` (`event_scheduler` or `event_assignment`) on
  the field definition instead of an automation.
- `project.patch.v1` shallow-merges onto the project document. Custom field
  values must be written under `custom_field_values`, where the storage layer
  merges them by path and validates them against the field definitions. For an
  assignee-typed field that validation only requires an object: the reference is
  not checked for existence or eligibility on this path, and a value written
  under `custom_fields` is dropped silently. Both are pinned as `GAP` assertions
  in the test, so closing either gap fails the test and prompts an update to the
  entry.
