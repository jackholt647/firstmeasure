# FirstMate Sales Bridge Chrome Extension

This unpacked Chrome extension coordinates two open tabs:

- `https://salesdialer.justcall.io/app/auto_dialer`
- `https://mail.google.com/mail/`

The JustCall content script shortens the existing left sidebar by 200px, injects a 200px FirstMate panel underneath it with the FirstMate icon and a **Send Email** button, then asks any open Gmail tab to compose a draft from the default template.

## Load It

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `firstmate-extension`.

## Configure It

Open the extension details page, then **Extension options**.

Set the bridge endpoint to your server path, for example:

```text
https://your-domain.example/measure/sales/firstmate-bridge/action.php
```

If you set `FIRSTMATE_SHARED_SECRET` in `../firstmate-bridge/action.php`, put the same value in the options page.

## Notes

Gmail's DOM changes often. This version uses common compose, recipient, subject, and body selectors, but it is intentionally small and easy to adjust after a real browser test.
