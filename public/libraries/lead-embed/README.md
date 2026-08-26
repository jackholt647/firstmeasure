# FirstMate Lead Embed Library

Public website embed for branch website lead forms. API code lives in `v1/lead-intake/api.ts`; authenticated form management uses `libraries/lead-intake-api/lead-intake-api.js`.

Use:

```html
<div id="firstmate-lead"></div>
<script
  src="https://app.1m8.ai/libraries/lead-embed/firstmate-lead-embed.js"
  data-form-id="form_example"
  data-target="#firstmate-lead">
</script>
```

Programmatic use:

```js
FirstMateLeadEmbed.render({
  formId: 'form_example',
  target: '#firstmate-lead',
  baseUrl: 'https://app.1m8.ai/v1/lead-intake'
});
```

The library fetches `GET /v1/lead-intake/public/forms/:formId`, renders the configured copy/style/scheduling fields, calls `GET /v1/lead-intake/public/forms/:formId/availability?date=YYYY-MM-DD` for calendar-style appointment slots, then posts to `POST /v1/lead-intake/public/forms/:formId/submit`. Submissions create Platform projects through the generic Platform lead creator.

For `mode: "instant_estimate"`, the same embed renders a paginated estimate flow, collects question answers, posts the public submission, and displays the returned estimate range. Solar measurement and customer email are server-side Lead Intake behavior, not browser behavior.

Website booking slots use the branch `scheduling` module. `availability.sales_appointment_start_time` and `availability.sales_appointment_end_time` are the shared earliest/latest sales appointment times used by both this public embed and Platform project scheduling.

Future models should not hard-code form markup in Platform screens. Manage forms through `LeadIntakeAPI.forms`, and use this public file for customer websites.
