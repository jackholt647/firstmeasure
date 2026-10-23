# Page brief for website-next (first drafts)

You are building first-draft pages for FirstMate's new marketing website. The
owner will rewrite the copy later, so spend your effort on **layout and sleek
animated UI mockups**, not on polishing words. Work fast: a page should take a
few minutes, not an hour.

## The site

- Root: `C:/Users/jackh/Code/2026/FirstMeasure/website-next/` (static HTML; it is
  served from a hidden subdirectory, so never use root-absolute links).
- Read first: `assets/site.css` (design tokens, buttons, cards, sections, and the
  **animated mockup kit** — `.mock`, `.mock-bar`, `.mock-side`, `.mock-main`,
  `.mock-row`, `.mock-chip`, `.mock-kpi`, `.mock-progress`, `.mock-bars`,
  `.mock-phone`, `.mock-float`, `.mock-toast`, `.mock-type`, `.pop`,
  `.slide-up`, `.slide-left`, `.fade`, `.draw`, `--d` stagger), `assets/site.js`
  (header/footer/menus, `~/` link rewriting, `.reveal` and `.mock` get class
  `in` when scrolled into view, `data-count` count-ups), and `index.html` (the
  home page — copy its mockup patterns and quality bar).
- **Do not edit** `assets/site.css`, `assets/site.js`, `index.html`, or another
  agent's pages. Put page-specific CSS in a `<style>` block in the page head,
  with class names prefixed by a short page prefix (e.g. `.crm-…`). If you think
  the shared files need a change, say so in your final report.
- Brand: red `#db0000`, Montserrat (headings 800–900, body 500), pill buttons
  (`.btn .btn-primary`, `.btn-outline`, `.btn-ghost`, `.btn-glass` on dark).
- Product name is **FirstMate** (the platform). FirstMeasure is the
  measurement product/module. Say "assignee", "team" or "your people" rather
  than hard-coding "crew" in descriptions of the platform (the nav's "Crew
  Management" label is fine as a marketing label).

## Page skeleton

Each page is `<dir>/index.html`. Asset paths are relative to the page depth
(`../assets/` at depth 1, `../../assets/` at depth 2). Internal links are written
`href="~/pricing/"` and rewritten by site.js — always use `~/` for internal
links. Sign up = `https://app.1m8.ai/portal/signup`, Log in =
`https://app.1m8.ai/portal/`, demo = `~/demo/`.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page Title — FirstMate</title>
<meta name="description" content="One sentence.">
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400..900;1,400..900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../../assets/site.css">
<style>/* page-only styles, prefixed */</style>
</head>
<body>
<div id="site-header"></div>
<main>
  <section class="page-hero">
    <div class="container split">
      <div>
        <div class="breadcrumb"><a href="~/solutions/">Solutions</a><span>Payments</span></div>
        <div class="eyebrow">Payments</div>
        <h1>Headline.</h1>
        <p class="lead">Subhead.</p>
        <div class="btn-row"><a class="btn btn-primary btn-lg" href="https://app.1m8.ai/portal/signup">Sign up free</a><a class="btn btn-ghost btn-lg" href="~/demo/">Book a demo</a></div>
      </div>
      <div class="mock-stage"> …animated mockup… </div>
    </div>
  </section>
  … 3–6 more sections …
  <section class="section"><div class="container"><div class="cta-band">…</div></div></section>
</main>
<div id="site-footer"></div>
<script src="../../assets/site.js"></script>
</body>
</html>
```

A dark hero is also fine: use `<section class="hero">` with `<body data-header="over-dark">`
(see index.html). Mix light, `section--soft` and `section--dark` sections.

## Content and visuals

- Typical solution/feature page: hero with an animated mockup → 3–4 key
  capabilities (alternating `.split` rows, each with its own small animated
  mockup) → a card grid of smaller features → how it connects to the rest of
  FirstMate (links to 3–4 related solutions) → FAQ (2–4 `<details class="faq">`)
  → CTA band.
- Mockups must look like simplified versions of the **real FirstMate UI**. Spend
  at most a few minutes looking at the real app to get names of tabs, columns,
  statuses and fields right: `C:/Users/jackh/Code/2026/FirstMeasure/public/libraries/apps/<app>/`,
  `public/portal/`, `public/measure/internal/` (measurement editor), and
  `docs/architecture/<topic>.md`. Use Grep/Glob with narrow patterns; don't read
  huge files whole. Do not run builds, tests, installs or git commands (the disk
  is nearly full and other sessions share this checkout).
- Animate with the kit: staggered `.slide-up`/`.pop` rows, progress bars,
  growing bar charts, `.draw` SVG line drawings, `.mock-type` typing, floating
  `.mock-float` cards, `.pulse-dot`. Small page scripts are fine (e.g. a looping
  ticker, cycling statuses) — keep them self-contained and respect
  `prefers-reduced-motion`.
- No photos. Where a photo will go later, use `<div class="placeholder-photo">Photo: crew installing shingles</div>`.
- Never fabricate facts presented as real: customer names, logos, quotes,
  statistics, prices, certifications, partner names. Use obvious placeholders
  ("Customer name", "Placeholder quote", "$—") or generic product claims. Use
  made-up homeowner names and addresses only inside UI mockups.
- Font Awesome 6 (solid) icons are loaded by site.js: `<i class="fa-solid fa-…"></i>`.
- Must work at phone width (no horizontal scroll; the grid/split classes
  collapse automatically — check your own custom grids).

## Check your work

A local server runs at `http://127.0.0.1:8765/` (root = website-next). Check each
page returns 200 with `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8765/<dir>/`,
and that your HTML has balanced tags. You may load a page in the browser pane
(`mcp__Claude_Browser__*`) for a quick look if those tools are available, but
don't spend long on it.

## Final report

Reply with: the files you wrote (paths), one line per page on what it shows, and
any suggestion for the shared files. Keep it short.
