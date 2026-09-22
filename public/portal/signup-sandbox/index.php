<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" content="#d93025">
    <title>Signup Workflow Sandbox</title>
    <link rel="icon" type="image/png" href="/images/icon.png">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/fonts.css">
    <link rel="stylesheet" href="sandbox.css?v=2">
</head>
<body>
    <header class="sbx-topbar">
        <div class="sbx-topbar-title">
            <i class="fa-solid fa-diagram-project"></i>
            <span>Signup Workflows</span>
            <span class="sbx-dev-badge">DEV</span>
        </div>
        <div class="sbx-topbar-actions">
            <button class="sbx-icon-btn" id="sbx-header-menu-btn" title="More"><i class="fa-solid fa-ellipsis"></i></button>
        </div>
    </header>
    <main class="sbx-layout">
        <aside class="sbx-sidebar">
            <div class="sbx-tabs" id="sbx-tabs">
                <button class="sbx-tab active" data-tab="workflows">Workflows</button>
                <button class="sbx-tab" data-tab="pages">Pages</button>
                <button class="sbx-tab" data-tab="orgs">Test orgs</button>
            </div>
            <div class="sbx-sidebar-body" id="sbx-sidebar-body"></div>
        </aside>
        <section class="sbx-main" id="sbx-main"></section>
    </main>
    <div class="sbx-modal-backdrop" id="sbx-modal-backdrop" hidden>
        <div class="sbx-modal" id="sbx-modal"></div>
    </div>
    <div class="sbx-menu" id="sbx-menu" hidden></div>
    <div class="sbx-toast" id="sbx-toast" hidden></div>
    <script src="sandbox.js?v=2"></script>
</body>
</html>
