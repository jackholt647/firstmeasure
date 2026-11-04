# Feature flags: the console and the API

A feature flag is an **organization switch**: a boolean value capability in
`platform/capability_defs.ts`, read with `isCapabilityEnabled` on the server and
`P.capabilities.value(key, false)` in the browser. Which apps a person sees is
[app experience](app-experience.md) and is not decided here.

Open the console with **Ctrl+Shift+F** on any `/measure/internal` page, or
Feature Flags in the staff portal's sidebar. It is
`public/measure/internal/portal_scripts/flag_console.js`. The API it uses, for
people and agents alike, is `/v1/internal/flags` (`internal/flags-api.ts`,
`platform/flag-console.ts`). Agents use `tools/feature-flags/cli.mjs`.

## What decides a flag

Evaluated when read (`capabilityValuesForUser`, `platform/flag-rollouts.ts`),
each layer over the last:

1. **Stored value**, `data.app_flags` on the organization's global document, or
   the default in the config library.
2. **Percentage.** One small document (platform configuration
   `capability_flag_rollouts`), never a row per organization. It turns on a flag
   whose value is off when `sha256("<flag>:<org id>")` falls under the percentage,
   so raising 10% to 20% keeps the first 10%, and each flag has its own order.
3. **Country rules.**
4. **Explicit value**, `data.app_flag_overrides`, set in the console: on or off,
   beating a percentage both ways. **Auto** clears it.
5. **Off for everyone** on the flag, which beats everything until restored.

Dependencies (`parent`, `requires`) then apply as always. A change reaches every
process within 15 seconds.

**A stored `false` is not an explicit off.** Signup and `saveCapabilityValues`
stamp every flag into `app_flags`, so a stored `false` usually only means it was
the default then. A percentage may turn those on. A stored `true` stays on and
is never removed by a percentage. To keep an organization out of a rollout, set
it off explicitly: that is the only way, and it is what the console's Off does.

A writer that saves through `saveCapabilityValues` (a preset, a sandbox setup)
replaces the explicit value for the flags it sets: the latest deliberate write
wins. `app_flag_overrides` is refused from customers on every path that refuses
`app_flags` (`containsAppFlagMutation`, signup).

`platform.expanded_access` and `platform.more_apps` cannot be rolled out by
percentage: `listExpandedPlatformOrgIds` selects them by stored value in SQL, and
they are a rollout ceiling of their own. Set them per organization.

## Exterior report ordering

The one gate for who may order is `firstmeasure.exteriors`:
`requireExteriorAccess` on the quote, upload and order paths, and the capability
in the order page. It is residential only; `firstmeasure.exteriors_commercial`
and `_multifamily` are declared and not yet read by the gate. Use this flag.

`FIRSTMEASURE_FULL_HOUSE_ENABLED` and `FIRSTMEASURE_FULL_HOUSE_EMAILS` do **not**
decide who orders. They gate staff work: internal `fullhouse_` drafts
(`full_house.php`, `authorizeFullHouseRequest`) and exterior training. Leave them
as they are; they are not a substitute for a flag. The emergency stop for
customer ordering is Off for everyone on the flag, which takes 15 seconds and
needs no host access.

## Introducing a flag

A flag can be **on but not yet introduced**: the organization has it, and each
person there who may use it is shown an announcement once, the first time they load
the app after it was turned on. This is for
an existing organization that gains something. An organization that starts with
the flag on (a new instant full organization, a platform signup) never sees it,
because nothing is new to it. What can be introduced is data: a flag has an
introduction when a [guided experience](guided-experiences.md#announcements) of
kind `announcement` names it as `introduces`. Exteriors: entry
`guided_experience/exteriors.introduction` on `firstmeasure.exteriors`.

The flag is simply on throughout, so ordering works before the popup is closed. The
state only decides whether the announcement may play (`platform/flag-introductions.ts`):

| Turned on by | Introduced? |
|---|---|
| Console or API with `introduce` (one organization, or a pasted list) | Yes, unless it already had the flag on, which is reported as `already_on` |
| A percentage saved with `introduce` | The organizations that raise added, if they existed when it was saved |
| Plain On, signup, a sandbox configuration, a preset, a country rule | No |

A percentage stays one document: each raise on such a flag is a step
(`steps: [{ percent, at, introduce }]`) and the first step covering an organization
decides, so a later raise never changes the answer for those it already covered. An
organization created after that step started with the flag.

Stored per organization in `data.flag_introductions`, refused from customers like
`app_flag_overrides`. Plain On, Auto or Off clear it. Being told is **per person** in
the guide's own server progress (`guided_progress`, subject the user id): closing it or
pressing Try It Now finishes it for that person only, and everyone else in the
organization (someone who joins later too) still sees it once while the state is set.
An experience that `introduces` a flag must have `scope: "person"`; the schema refuses
an organization-wide one, which only the first person to load the app would see
(FM-327). Once a person finished it, it never plays again for them, even if the state
is set again. On dev, the dev console's Guided experiences section plays it again (reset for
yourself, or for the whole organization). The console shows Waiting (nobody there has seen it yet) or Introduced, with how
many people have (`introduced_people`), on the organization's row. There is no count
of organizations waiting.

"Each person" means each person the announcement is for: its `eligibility` still
applies. Exteriors' names no permission, so everyone in the organization is told, including
people who cannot order reports (Ben, FM-327 reopened: the second person tried on production
had a custom role with Order reports off, and the entry then required it). An announcement
that does require one is never shown to someone without it; the console reads that from the
announcement (`introduction_audience`, the required permissions' labels) and says, e.g.,
"each person there who may order reports" instead of "each person".

## Counts

Each flag's "on" count applies the stored value, percentage, explicit value,
off-for-everyone and dependencies. It leaves out country rules (the console
marks a flag that has one), billing entitlements and the per-user audience
of `platform.expanded_access`, so it says how many organizations have the switch
on, not how many people see something. Counts come from one paged scan of every
organization, cached for a minute
([backlog](../optimization-backlog.md#feature-flag-counts-scan-every-organization)).

## Access

Declared in `internal/route-access.ts`.

| Who | May |
|---|---|
| Staff with a full admin role or `platform_admin` | read and change everything, manage keys |
| Staff with `manage_users` or `manage_sales_users` | read |
| A read key | read |
| A write key | read and change flags, never manage keys |
| Anyone else | nothing |

Keys carry their own proof, so the key-accepting routes are declared public and
one `preHandler` over the whole plugin requires a verified session or a live key
before any handler runs ([request security](request-security.md)). Key management
routes are `{ staff: "admin" }`, so a key can never reach them. Only a hash of a
key is stored; it is shown once when created. A flag key opens this API only.

## Audit log

Every change through the console, the API or the CLI is one entry: who (the staff
member, or the key's name and its creator), when, what, before and after, and
why if given. A bulk action is one entry with one before and after per
organization. Country rule saves and `POST /admin/organizations/:orgId/app-flags`
are logged too. Other writers that are not operator actions (accepting an app
offer, signup) are not.

Tables `feature_flag_audit`, `feature_flag_audit_orgs` and `feature_flag_keys` are
in the `feature_flags` SQL store. When `initialize` changes, raise its
`schemaVersion`.

## API

Base `https://dev.1m8.ai/v1/internal/flags` (production `https://app.1m8.ai`).
Send `Authorization: Bearer <key>`, or a staff session cookie.

| Route | Does |
|---|---|
| `GET /me` | who you are, whether you can change flags |
| `GET /catalog` (`?fresh=1` recounts) | every flag, description, counts, rollout |
| `GET /catalog/:key/coverage?percent=` | how many a percentage would cover, without saving |
| `PUT /catalog/:key/rollout` `{percent?, killed?, introduce?, note?}` | set a percentage or off for everyone; `introduce` announces it to organizations a raise adds |
| `GET /orgs?q=` | find by name, id or anyone's email |
| `GET /orgs/:orgId` | one organization's flags and why each has its value |
| `PUT /orgs/:orgId/flags/:key` `{value: true\|false\|null, introduce?, note?}` | explicit on, off, or Auto; `introduce` with on |
| `POST /resolve` `{text}` | what a pasted list matches; changes nothing |
| `POST /bulk` `{flag, value, introduce?, org_ids, note?}` | one action for up to 5000 organizations |
| `GET /audit` (`?flag= &org= &before= &limit=`), `GET /audit/:id` | the log |
| `GET, POST /keys`, `DELETE /keys/:id` | administrator session only |

## CLI

```bash
node tools/feature-flags/cli.mjs list exteriors
node tools/feature-flags/cli.mjs org owner@example.com
node tools/feature-flags/cli.mjs set org_abc firstmeasure.exteriors on --note "pilot"
node tools/feature-flags/cli.mjs set org_abc firstmeasure.exteriors introduce --note "tell them"
node tools/feature-flags/cli.mjs bulk firstmeasure.exteriors on pilot-orgs.txt --note "pilot"
node tools/feature-flags/cli.mjs coverage firstmeasure.exteriors 10
node tools/feature-flags/cli.mjs percent firstmeasure.exteriors 10 --introduce --note "first 10%"
node tools/feature-flags/cli.mjs kill firstmeasure.exteriors
```

Keys live in `~/.config/firstmate/feature-flags-key`, or `FM_FLAGS_KEY`. Add
`--prod` for production, which reads its own file,
`feature-flags-key-prod`, so a dev key is never sent there by accident.

## Agent machines

Tracker workers and other agents on a listed machine set flags themselves on dev.
Each machine in `public/v1/config-library/agent-machines.json` fetches its own
write key, never in a transcript, chat or log:

```bash
sh tools/feature-flags/enroll.sh agents:fm-agents-1
```

It signs with the machine's `~/.ssh/fm_config_library_ed25519`, in its own
namespace, and writes `~/.config/firstmate/feature-flags-key` (mode 600), printing
only the key's id. Enrolling again replaces and revokes the earlier key. The
route exists only in the development data environment. The CLI then works from any
checkout on that machine, and every change is in the audit log under the machine's
name.

**Production.** There is no enrollment, and no agent creates a production key. A
platform administrator (Jack) makes one and hands it over without it entering a
chat or a transcript:

1. In production, Ctrl+Shift+F, Agent keys: create it, named for the machine and
   read-only unless changes are needed, with the fewest days that will do.
2. Copy it, then on the PC run this. It prompts without echoing, so the key is in
   neither shell history nor the process list:
   ```bash
   ssh -t fm-agents 'umask 077; mkdir -p ~/.config/firstmate; read -rs -p "Key: " k; printf "%s" "$k" > ~/.config/firstmate/feature-flags-key-prod; unset k; echo'
   ```
3. Agents then add `--prod`. Revoke it in the same tab when it is no longer needed.

This is not in the [agent how-to index](agent-how-to-index.md): those recipes are
for the assistant customers talk to, which must never reach this API.

## Not built

- New-organization defaults are not in the console. They are the config library
  entry `app_flag_defaults/new_organization`, edited on dev.
- The old console's variant split test and per-organization variant editor went
  with it (`firstmeasure.referral_offer`). It read files that production keeps in
  Postgres. Values already stored still apply. Say so if this is wanted again.
- Settings that hold a number or a choice are shown, not edited, here.

## Tests

`tests/feature-flags.test.ts`, `tests/flag-introductions.test.ts`, `tests/route-access.test.ts`,
`tests/access-gates.test.ts`.
