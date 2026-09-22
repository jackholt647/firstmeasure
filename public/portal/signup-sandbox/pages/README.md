# Signup Sandbox pages

Custom (agent-built) signup pages live here, one folder per page id:

```
public/portal/signup-sandbox/pages/<page_id>/page.js
```

## Contract

`page.js` is a plain script (no build step). It must register itself on a global
registry keyed by the page id:

```js
(function () {
    'use strict';
    window.SignupSandboxPages = window.SignupSandboxPages || {};
    window.SignupSandboxPages['spg_xxxxxxxxxxxxxxxx'] = {
        render(container, ctx) {
            // Build the page UI inside `container`.
            // The user is already logged in as a fresh test org, so any
            // authenticated /v1/* API can be called with credentials:'include'
            // (send the fm_platform_session_csrf cookie value as X-Platform-CSRF
            // on mutating platform calls).
            const button = document.createElement('button');
            button.textContent = 'Continue';
            button.addEventListener('click', () => ctx.complete());
            container.appendChild(button);
        }
    };
})();
```

The page renders inside the dev-bar stage overlay on the real portal
(`/portal/?sbx_stage=<index>`); the logged-in test org's whole app is behind
it. `ctx` fields:

| Field | Meaning |
|---|---|
| `ctx.workflow` | The full workflow document. |
| `ctx.stage` | The stage entry (`{id, page_id, notes, page, target}`). |
| `ctx.page` | The page document (title, brief, implementation, …). |
| `ctx.instanceId` | The sandbox test-instance id. |
| `ctx.apiBaseUrl` | Base URL of `/v1/signup-sandbox`. |
| `ctx.back()` | Return to the preceding workflow stage. |
| `ctx.complete()` | Mark this stage done (records completion, applies effects) and advance to the next stage's surface. |

## Wiring a built page up

After creating `pages/<page_id>/page.js`, mark the page implemented so the
runner loads it (from the builder's page editor, or directly):

```
PATCH /v1/signup-sandbox/pages/<page_id>
{ "status": "implemented", "implementation": { "type": "bundle", "bundle": "pages/<page_id>/page.js" } }
```

The dev bar then loads `/portal/signup-sandbox/pages/<page_id>/page.js` into
the stage overlay and calls `render()` whenever that stage is shown.

## Rules for agents building pages

- Read the page's `brief` (shown on the placeholder card and in the builder).
- One folder per page id; never share files between pages — pages must stay
  individually copyable between machines along with their JSON documents.
- Follow FirstMate UI conventions: FontAwesome icons (no emoji), the
  `--primary` / `--secondary` / `--accent` CSS variables, and don't restyle the
  runner chrome.
- Variants (`variant_of` set) get their own folder and bundle; copy the source
  page's bundle as a starting point if useful.
