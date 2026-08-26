# FirstMate Landing Pages

Landing pages live in `landing/variants/{slug}/` and are loaded through `landing/index.php`.

The page can own any HTML, CSS, JS, and remote assets it needs. The shared contract is the signup widget:

```html
<div
  data-firstmate-signup
  data-mode="register"
  data-show-login="true"
  data-referral="auto"></div>
<script src="/landing/shared/signup-widget.js"></script>
```

## Widget Behavior

- Renders inside Shadow DOM so page styles do not leak into the form.
- Does not set page, body, layout, or outer margin styles.
- Reads `ref`, `utm_*`, `fbclid`, `_fbc`, and `_fbp` from the current URL.
- Fetches public referral data from `/v1/platform/referrals/public/{code}`.
- Sends registration, login, forgot-password, OTP, and reset-password actions to `/v1/platform/auth/legacy-action`.
- Redirects first-login users to portal onboarding.
- Emits `firstmate:ready`, `firstmate:mode-change`, `firstmate:referral-loaded`, `firstmate:referral-error`, `firstmate:auth-success`, and `firstmate:signup-error`.

## Adding a Variant

1. Create `landing/variants/example/index.php`.
2. Add the slug to `$variants` in `landing/index.php`.
3. Include one or more widget mount points where signup should appear.

The default variant is `measurements`.

Current variants:

- `measurements`: default public roof-measurements signup page.
- `customer-referral` or `referral`: base customer referral page. It uses the default measurements marketing page and adds only a small “You were invited to FirstMate” reminder.
- `representative-referral`, `rep-referral`, or `manufacturer-referral`: partner/manufacturer representative referral page. It uses the default measurements marketing page and puts partner name/logo plus any invitee-facing offer inside the invite box.
