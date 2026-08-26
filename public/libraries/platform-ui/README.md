# Platform UI Library

Shared browser UI affordances for Platform pages.

Load before `platform/scripts/core.js`:

```html
<script src="../libraries/platform-ui/platform-ui.js"></script>
```

API:

- `PlatformUI.showToast(title, message, ok)` and `PlatformUI.hideToast()`
- `PlatformUI.alert(message, { title, okLabel })`
- `PlatformUI.confirm(message, { title, okLabel, cancelLabel, danger })`
- `PlatformUI.prompt(message, defaultValue, { title, okLabel, cancelLabel })`
- `PlatformUI.installBrowserDialogOverrides()` routes `window.alert`, `window.confirm`, and `window.prompt` through the styled async dialogs. The originals remain available at `PlatformUI.native`.
- `PlatformUI.showTooltip(target, { text })` or `PlatformUI.showTooltip(target, { html })`
- `PlatformUI.hideTooltip()`
- `PlatformUI.initTooltips()`

Declarative tooltips:

```html
<button data-fm-tooltip="Reload">...</button>
<span class="fm-ui-help" tabindex="0" data-fm-tooltip="Helpful context.">?</span>
```

Use `data-fm-tooltip` instead of native `title` attributes in Platform UI so hover/focus behavior and styling stay consistent.
