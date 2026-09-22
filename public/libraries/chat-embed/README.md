# FirstMate Chat Embed

Public browser embed for FirstMate live chat. Drop-in script for customer
websites; also mounted inside the customer portal with a portal grant.

## Embed

```html
<script src="https://app.1m8.ai/libraries/chat-embed/firstmate-chat-embed.js"
        data-widget-key="cw_your_key" async></script>
```

The widget key comes from **Settings → Live Chat → Widget** (copyable snippet
there). Optional attributes: `data-base-url` (override the API base),
`data-position` (`bottom_right` | `bottom_left` — normally set in settings),
`data-auto="false"` (skip auto-init and call `FirstMateChatEmbed.init()`
yourself).

## Programmatic API

```js
FirstMateChatEmbed.init({ widgetKey, baseUrl, portalGrant });
FirstMateChatEmbed.open();
FirstMateChatEmbed.close();
FirstMateChatEmbed.identify({ name, email, phone }); // host page knows the user
FirstMateChatEmbed.destroy();
```

## How it works

- Fetches whitelisted config from `GET /v1/chat/public/widgets/:key` — colors,
  copy, position, pre-chat requirements, online status. All theming is
  server-driven and scoped under a random instance id so styles never leak
  into the host page.
- Anonymous by design: `credentials:'omit'`; identity is a bearer visitor
  token minted by `POST .../sessions` and kept in
  `localStorage["fmchat:<key>"]`, so conversations survive reloads and
  revisits. If storage is unavailable the chat still works for the page view.
- Polls the conversation feed every 2.5s while open (15s in background); the
  same request doubles as the visitor-presence heartbeat.
- Offline flow: when the org is offline (live hours / presence / override) and
  no AI agent fronts the chat, the widget collects an email and the backend
  files a lead.
- `demo.html` in this directory is a stand-in customer page for local testing:
  `http://127.0.0.1:8011/libraries/chat-embed/demo.html?key=cw_…`.

Server counterpart: `public/v1/chat/` (spec: `docs/live-chat-spec.md`).
