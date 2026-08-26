<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="/fonts.css">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      font-family: 'Montserrat', 'Segoe UI', Roboto, sans-serif;
      color: #111827;
      background:
        linear-gradient(105deg, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.9) 46%, rgba(255,255,255,0.24) 72%, rgba(255,255,255,0.08) 100%),
        url('images/gutter_installer.png') center / cover no-repeat;
    }
    .billboard {
      height: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, 36%);
      gap: clamp(18px, 3vw, 34px);
      align-items: center;
      padding: clamp(24px, 4vw, 46px);
    }
    .copy {
      display: grid;
      gap: clamp(12px, 2vw, 20px);
      max-width: 680px;
    }
    .eyebrow {
      width: max-content;
      border-radius: 999px;
      padding: 8px 12px;
      background: rgba(217, 48, 37, 0.1);
      color: #b1241c;
      font-size: clamp(11px, 1.2vw, 13px);
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    h1 {
      margin: 0;
      max-width: 12ch;
      font-size: clamp(42px, 6vw, 82px);
      line-height: 0.96;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      max-width: 42rem;
      color: #374151;
      font-size: clamp(17px, 1.9vw, 24px);
      line-height: 1.42;
      font-weight: 750;
    }
    ul {
      margin: 0;
      padding-left: 1.2em;
      max-width: 42rem;
      color: #374151;
      font-size: clamp(15px, 1.55vw, 19px);
      line-height: 1.45;
      font-weight: 650;
    }
    li + li {
      margin-top: 8px;
    }
    .report {
      align-self: center;
      min-height: 0;
      border: 0;
      border-radius: 16px;
      background: #fff;
      box-shadow:
        0 24px 50px rgba(17,24,39,0.18),
        0 4px 14px rgba(17,24,39,0.08);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 14px;
      overflow: hidden;
    }
    .report img {
      width: 100%;
      max-width: 520px;
      max-height: calc(100vh - 80px);
      height: auto;
      object-fit: contain;
      border-radius: 8px;
      filter:
        drop-shadow(0 2px 3px rgba(17,24,39,0.16))
        drop-shadow(0 10px 18px rgba(17,24,39,0.14));
    }
  </style>
</head>
<body>
  <main class="billboard" aria-label="FirstMate login marketing">
    <section class="copy">
      <div class="eyebrow">Introducing</div>
      <h1>Gutter Reports</h1>
      <p>Add gutters to any roof report for just $2</p>
      <ul>
        <li>Active gutters linear feet</li>
        <li>Stories by direction</li>
        <li>Diagram with each run labelled</li>
        <li>Miter counts for inside 90, outside 90, and non-90 corners</li>
      </ul>
    </section>
    <aside class="report" aria-hidden="true">
      <img src="images/gutter-report-sample.webp" alt="">
    </aside>
  </main>
</body>
</html>