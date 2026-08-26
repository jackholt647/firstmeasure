# FirstMeasure customer API documentation

This directory is the deployable documentation tree for `/documentation/`. It is self-contained apart from the existing brand logo and font assets in `public/images` and `public/fonts`.

The API explorer is intentionally restricted to `fmk_test_` keys. It targets the same-origin production API path, never persists the key, generates idempotency keys for report creation, polls sandbox report status, and downloads binary artifacts.

Run the documentation checks from the repository root:

```sh
node --check public/documentation/app.js
node --test public/documentation/tests/smoke.mjs
```

Deploy the entire `public/documentation` directory together. The public URL remains `https://app.1m8.ai/documentation/`.

