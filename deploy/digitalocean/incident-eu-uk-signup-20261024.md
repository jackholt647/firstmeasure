# Incident: eu.1m8.ai UK signup forms disabled, October 23–24, 2026

## What happened

Release `bf8a99a8` (1M8-240) removed the Country and Language dropdowns from the app's region library (`signup-region.js`). The eu.1m8.ai `uk/` and `uk2/` landing pages ran their own copy of the signup form, hosted on the website droplet, and that copy waited for those dropdowns.

From that release until the website switch, those pages showed "Country and phone options could not be loaded…" and the phone field was disabled, so no one could sign up there. The 1m8.ai pages were not affected.

- **Started:** about 21:00 UTC on Oct 23, when `bf8a99a8` went live.
- **Fixed:** at the switch to the app's embedded form, website release `20261023-signup-embed` on eu.1m8.ai, recorded in `22733263` on `claude/websites-signup-embed-20261024`.

## Why it was missed

The release checks covered the app's own `login.php`, the app landing pages and the website hand-off tag. They did not cover the websites' own form copies, which load app libraries cross-site.

## Lesson

Before changing a shared library under `public/libraries`, check every consumer, including website pages on the droplets that load it from app.1m8.ai.
