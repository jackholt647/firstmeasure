# SMS registration policies: development verification

Source commit `3fde05106356a85fe14109c7e24a8e7fec64be1c` updates the SMS registration workflow with campaign-description guidance, clearer texting policy and public-policy copy, screenshot-only evidence uploads, a 600-character limit for campaign and consent text, screenshot-link budget enforcement, a reset area-code search, and a shorter review checklist after the application preview.

Validation completed: `npm run check`; four browser workflow tests on both the checkout and the host-merged development asset; focused 10DLC campaign and screenshot-upload API tests; `node --check`; and `git diff --check`. The browser checks covered changing numbers, screenshot limits, missing SMS terms navigation, and the review layout.

The guarded rollout overlaid only the SMS settings asset and messaging API source/build on the current development bases. Web, pool, compatibility, and worker roles report active on release `3fde05106356a85fe14109c7e24a8e7fec64be1c`. Public `https://dev.1m8.ai/v1/health/ready` reported ready, and the served settings asset SHA-256 matched the staged payload: `2c70b49f9f01f4602f8b9cad2e53e98ed24396e556808e181137b6370e3cf21d`.

Production was not activated.
