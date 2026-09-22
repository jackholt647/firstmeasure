# FirstMate Insights library

`public/libraries/insights/firstmate-insights.js` is the shared runtime for contextual recommendations. It owns the uploaded Insights icon, hover treatment, adaptive popover placement, outside-click/Escape behavior, optional image and video content, and inline agent conversation.

The portal loads the library globally. A separately loaded app can include the one JavaScript file; it discovers and loads its adjacent stylesheet automatically.

## Add an insight

```js
const insight = FirstMateInsights.mount(document.querySelector('[data-tax-help]'), {
  id: 'invoice_tax_behavior',
  title: 'Tax behavior',
  body: 'Choose inclusive tax when the displayed price should already contain tax.',
  image: {
    src: '/media/help/tax-example.png',
    alt: 'Example invoice with tax included',
    caption: 'The customer sees one tax-inclusive total.'
  },
  // This is sent to the Insights agent but is never rendered in the popover.
  developerContext: 'Explain inclusive versus exclusive sales tax. Do not provide legal or tax advice.'
});

// Remove both the trigger and its listeners when an app surface unmounts.
insight.destroy();
```

`video` accepts the same shape as `image`, plus `poster`, `controls`, and `preload`. Use `media` for multiple items. Plain text is the safe default; developers can set `allowHtml: true` for trusted product markup or provide a function/DOM node as `body`.

## Register once, mount many times

```js
FirstMateInsights.register('project_stage_rules', {
  title: 'Stage rules',
  body: 'Stage rules run when a project enters this stage.',
  developerContext: 'Keep answers specific to project workflow stages.'
});

FirstMateInsights.mount(stageHeader, 'project_stage_rules');
```

Declarative hosts are supported after registration:

```html
<span data-firstmate-insight="project_stage_rules"></span>
<script>FirstMateInsights.scan(document);</script>
```

## Customer controls

Configuration → Insights writes `insights_settings` through the normal branch-module API:

- `enabled`: shows or hides all standard insight triggers.
- `agent_enabled`: adds the inline conversation composer.

The settings preview uses `preview: true`, so it remains visible while Insights are off. System prompts and `developerContext` are developer-owned and are intentionally absent from customer settings.

The runtime also exposes `configure`, `create`, `open`, `close`, `loadPreferences`, `savePreferences`, `setSettings`, `getSettings`, `getDefinition`, and `clearSession` for embedded-app integration.
