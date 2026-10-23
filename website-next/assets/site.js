/* FirstMate website (next) — shared header, mega menus, footer and motion.
 *
 * A page includes:
 *   <div id="site-header"></div> ... <main>...</main> ... <div id="site-footer"></div>
 *   <script src="<relative>/assets/site.js" defer></script>
 * Links inside the site are written href="~/path/" and rewritten here to the
 * site's base (the preview lives under a hidden subdirectory today).
 * <body data-header="over-dark"> makes the header transparent over a dark hero. */
(function () {
  'use strict';

  var script = document.currentScript || document.querySelector('script[src*="assets/site.js"]');
  var BASE = new URL('..', script.src).pathname.replace(/\/$/, '');
  var APP = 'https://app.1m8.ai';
  var LOGIN = APP + '/portal/';
  var SIGNUP = APP + '/portal/signup';
  function u(path) { return BASE + path; }

  // Shared with pages that want the same lists (e.g. the Solutions overview).
  var SOLUTIONS = [
    { group: 'Measure & document', items: [
      ['roof-measurements', 'Roof Measurements', 'Pitch, facets and waste in hours', 'fa-house-chimney'],
      ['full-exterior', 'Full Exterior Reports', 'Roof, siding, gutters and openings', 'fa-ruler-combined'],
      ['full-house', 'Full House Reports', 'Every structure on the property', 'fa-city'],
      ['photos', 'Photos & Project Feed', 'Every jobsite photo, organized', 'fa-camera']
    ]},
    { group: 'Win the work', items: [
      ['crm', 'CRM & Lead Tracking', 'Every lead, follow-up and source', 'fa-filter'],
      ['proposals', 'Proposals & E-Signature', 'Good-better-best, signed on the spot', 'fa-file-signature'],
      ['documents', 'Document Studio', 'Contracts and reports from your data', 'fa-pen-ruler'],
      ['canvassing', 'Canvassing', 'Door-to-door maps and activity', 'fa-map-location-dot'],
      ['communications', 'Calls, Texts & Inbox', 'Every conversation in one place', 'fa-inbox'],
      ['forms-booking', 'Forms & Online Booking', 'Quotes and appointments from your site', 'fa-calendar-check'],
      ['website-builder', 'Website Builder', 'Edit your company site yourself', 'fa-globe'],
      ['reviews', 'Reviews & Feedback', 'Ratings from every finished job', 'fa-star']
    ]},
    { group: 'Run the job', items: [
      ['scheduling', 'Scheduling', 'Dispatch people and equipment', 'fa-calendar-days'],
      ['material-management', 'Material Management', 'Scope, orders and deliveries', 'fa-boxes-stacked'],
      ['work-orders', 'Work Orders & Job Tracking', 'From signed to finished', 'fa-clipboard-list'],
      ['crew-management', 'Crew Management', 'A field app for every assignee', 'fa-helmet-safety'],
      ['checklists', 'Checklists', 'Standardize every visit', 'fa-list-check'],
      ['customer-portal', 'Customer Portal', 'Homeowners follow along live', 'fa-user-lock'],
      ['partners', 'Partners & Subcontractors', 'Share work across companies', 'fa-handshake'],
      ['equipment', 'Equipment', 'Trucks, trailers and upkeep', 'fa-truck-pickup'],
      ['channels', 'Team Channels', 'Chat by job, team or topic', 'fa-comments'],
      ['training', 'Training', 'Build and assign courses', 'fa-graduation-cap']
    ]},
    { group: 'Get paid', items: [
      ['payments', 'Payments', 'Card and bank, in person or online', 'fa-credit-card'],
      ['invoicing', 'Invoicing', 'Bill on milestones, track aging', 'fa-file-invoice-dollar'],
      ['payroll', 'Payroll & Commissions', 'Piece rate, hourly and commission', 'fa-money-check-dollar'],
      ['financials', 'Job Costing & Financials', 'Profit on every job', 'fa-chart-line'],
      ['reporting', 'Reports & Stats', 'Sales and production numbers', 'fa-chart-column'],
      ['receipts', 'Receipts & Expenses', 'Snap it, code it, done', 'fa-receipt']
    ]},
    { group: 'AI & automation', items: [
      ['assistant', 'FirstMate Assistant', 'An AI that knows your business', 'fa-wand-magic-sparkles'],
      ['automations', 'Automations', 'Follow-ups that run themselves', 'fa-bolt'],
      ['integrations', 'Integrations', 'Payments, phone, email and your APIs', 'fa-plug']
    ]}
  ];

  var FOOT_LINKS = '<a href="~/demo/">Schedule a demo</a><a href="~/reviews/">Customer reviews</a><a href="~/download/">Download the app</a>';

  var MENUS = [
    { label: 'Who We Serve', cols: 3, html:
      col('Company size', '~/who-we-serve/', [
        ['~/who-we-serve/small/', 'Small', '1–10 employees', 'fa-user'],
        ['~/who-we-serve/medium/', 'Medium', '11–49 employees', 'fa-user-group'],
        ['~/who-we-serve/enterprise/', 'Enterprise', '50+ employees', 'fa-building'],
        ['~/who-we-serve/franchise/', 'Franchise', 'Part of a larger network', 'fa-network-wired']
      ]) +
      col('Popular trades', '~/trades/', [
        ['~/trades/roofing/', 'Roofing', '', 'fa-house-chimney'],
        ['~/trades/exteriors/', 'Siding & Exteriors', '', 'fa-house'],
        ['~/trades/general-contractors/', 'General Contractors', '', 'fa-hammer'],
        ['~/trades/restoration/', 'Restoration', '', 'fa-house-flood-water'],
        ['~/trades/solar/', 'Solar', '', 'fa-solar-panel'],
        ['~/trades/hvac/', 'HVAC', '', 'fa-fan'],
        ['~/trades/landscaping/', 'Landscaping', '', 'fa-tree']
      ], true) +
      '<div class="mega-col"><h6>See it in action</h6>' +
      link('~/demo/', 'Schedule a demo', 'A live walkthrough for your team', 'fa-play') +
      link('~/reviews/', 'Customer reviews', 'What contractors say', 'fa-star') +
      link('~/download/', 'Download the app', 'iPhone and Android', 'fa-mobile-screen') + '</div>'
    },
    { label: 'Solutions', cols: 5, wide: true, html: SOLUTIONS.map(function (g) {
        return col(g.group, null, g.items.map(function (i) { return ['~/solutions/' + i[0] + '/', i[1], '', i[3]]; }), false);
      }).join('') + '<div class="mega-foot"><a href="~/solutions/">Explore all solutions →</a>' + FOOT_LINKS + '</div>'
    },
    { label: 'Pricing', href: '~/pricing/' },
    { label: 'Support', cols: 2, promo: ['Talk to real people', 'Our support team are roofers and contractors who know the software and the trade.', '~/support/contact/', 'Contact support'], html:
      '<div class="mega-col"><h6>Get help</h6>' +
      link('~/support/faq/', 'FAQ', 'All your burning questions, answered', 'fa-circle-question') +
      link('~/support/help-center/', 'Help Center', 'The ins and outs of FirstMate', 'fa-life-ring') +
      link('~/support/contact/', 'Contact Us', 'We would love to hear from you', 'fa-envelope') + '</div>' +
      '<div class="mega-col"><h6>Learn <a href="~/resources/classes/">All classes</a></h6>' +
      link('~/resources/classes/', 'Classes', 'Live and on-demand training', 'fa-chalkboard-user') +
      link('~/resources/user-guides/', 'User guides', 'A workflow for your role', 'fa-book-open') +
      link('~/forum/', 'Community forum', 'Ask other contractors', 'fa-people-group') + '</div>' +
      '<div class="mega-foot">' + FOOT_LINKS + '</div>'
    },
    { label: 'Resources', cols: 3, promo: ['The FirstMate Forum', 'Real contractors, real conversations. Ask questions, share wins and talk shop with our team.', '~/forum/', 'Join the forum'], html:
      '<div class="mega-col"><h6>Learn</h6>' +
      link('~/resources/', 'Resource Hub', 'Everything in one place', 'fa-layer-group') +
      link('~/resources/classes/', 'Classes', 'Become a FirstMate expert', 'fa-chalkboard-user') +
      link('~/resources/webinars/', 'Webinars', 'Learn from other pros', 'fa-video') +
      link('~/resources/blog/', 'Blog', 'Industry tips and news', 'fa-newspaper') +
      link('~/resources/case-studies/', 'Case Studies', 'Real customer stories', 'fa-chart-simple') +
      link('~/resources/user-guides/', 'User Guides', 'A workflow for your role', 'fa-book-open') + '</div>' +
      '<div class="mega-col"><h6>Connect</h6>' +
      link('~/forum/', 'Community Forum', 'Contractors talking shop', 'fa-people-group') +
      link('~/resources/podcast/', 'Podcast', 'Stories from the trades', 'fa-microphone') +
      link('~/resources/built-right/', 'Built Right', 'Celebrating the people who build', 'fa-trophy') + '</div>' +
      '<div class="mega-col"><h6>FirstMate</h6>' +
      link('~/about/', 'About', '', 'fa-compass') +
      link('~/careers/', 'Careers', '', 'fa-briefcase') +
      link('~/press/', 'Press', '', 'fa-bullhorn') +
      link('~/trade-shows/', 'Trade Shows', '', 'fa-calendar') + '</div>' +
      '<div class="mega-foot">' + FOOT_LINKS + '</div>'
    }
  ];

  function link(href, title, desc, icon) {
    return '<a class="mega-link' + (desc ? '' : ' compact') + '" href="' + href + '"><span class="ic"><i class="fa-solid ' + icon + '"></i></span><span><b>' + title + '</b>' + (desc ? '<small>' + desc + '</small>' : '') + '</span></a>';
  }
  function col(title, all, items, dense) {
    return '<div class="mega-col' + (dense && items.length > 5 ? ' dense' : '') + '"><h6>' + title + (all ? ' <a href="' + all + '">See all</a>' : '') + '</h6>' +
      items.map(function (i) { return link(i[0], i[1], i[2], i[3]); }).join('') + '</div>';
  }

  function header() {
    var nav = MENUS.map(function (m, idx) {
      if (m.href) return '<div class="nav-item"><div class="nav-top"><a href="' + m.href + '">' + m.label + '</a></div></div>';
      var promo = m.promo ? '<div class="mega-promo"><b>' + m.promo[0] + '</b><p>' + m.promo[1] + '</p><a class="btn btn-primary btn-sm" href="' + m.promo[2] + '">' + m.promo[3] + '</a></div>' : '';
      var cols = m.wide ? 'repeat(5, minmax(0, 1fr))' : null;
      return '<div class="nav-item" data-menu="' + idx + '"><div class="nav-top"><button type="button" aria-expanded="false">' + m.label + '</button></div>' +
        '<div class="mega" role="region" aria-label="' + m.label + '"><div class="mega-inner' + (promo ? ' has-promo' : '') + '" style="--cols:' + m.cols + '">' +
        m.html.replace('<div class="mega-foot">', promo + '<div class="mega-foot">') + '</div></div></div>';
    }).join('');
    return '<header class="site-header" id="top-header"><div class="header-inner">' +
      '<a class="brand" href="~/" aria-label="FirstMate home"><img class="logo-dark" src="' + u('/assets/img/logo_black.png') + '" alt="FirstMate"><img class="logo-light" src="' + u('/assets/img/logo_white.png') + '" alt=""></a>' +
      '<nav class="nav" aria-label="Main">' + nav + '</nav>' +
      '<div class="header-actions"><a class="header-login" href="' + LOGIN + '">Log in</a><a class="btn btn-ghost btn-sm" href="~/demo/">Book a demo</a><a class="btn btn-primary btn-sm" href="' + SIGNUP + '">Sign up free</a></div>' +
      '<button class="menu-toggle" type="button" aria-label="Menu"><span></span><span></span><span></span></button>' +
      '</div></header>';
  }

  function footer() {
    function list(t, items) { return '<div><h6>' + t + '</h6>' + items.map(function (i) { return '<a href="' + i[0] + '">' + i[1] + '</a>'; }).join('') + '</div>'; }
    return '<footer class="site-footer"><div class="container"><div class="footer-grid">' +
      '<div class="footer-brand"><img src="' + u('/assets/img/logo_white.png') + '" alt="FirstMate"><p>The operating system for contractors: measure, sell, build and get paid in one place.</p><div class="btn-row"><a class="btn btn-primary btn-sm" href="' + SIGNUP + '">Sign up free</a></div></div>' +
      list('Measure', [['~/solutions/roof-measurements/', 'Roof measurements'], ['~/solutions/full-exterior/', 'Full exterior'], ['~/solutions/full-house/', 'Full house'], ['~/solutions/photos/', 'Photos']]) +
      list('Platform', [['~/solutions/', 'All solutions'], ['~/solutions/crm/', 'CRM'], ['~/solutions/proposals/', 'Proposals'], ['~/solutions/payments/', 'Payments'], ['~/solutions/scheduling/', 'Scheduling'], ['~/pricing/', 'Pricing']]) +
      list('Who we serve', [['~/who-we-serve/small/', 'Small teams'], ['~/who-we-serve/enterprise/', 'Enterprise'], ['~/trades/roofing/', 'Roofing'], ['~/trades/exteriors/', 'Exteriors'], ['~/trades/', 'All trades']]) +
      list('Resources', [['~/resources/', 'Resource hub'], ['~/forum/', 'Forum'], ['~/resources/blog/', 'Blog'], ['~/resources/case-studies/', 'Case studies'], ['~/support/help-center/', 'Help center']]) +
      list('Company', [['~/about/', 'About'], ['~/careers/', 'Careers'], ['~/press/', 'Press'], ['~/support/contact/', 'Contact']]) +
      '</div><div class="footer-bottom"><span>© ' + new Date().getFullYear() + ' FirstMate. All rights reserved.</span><span><a href="https://1m8.ai/privacy">Privacy</a><a href="https://1m8.ai/terms">Terms</a></span></div></div></footer>';
  }

  function rewriteLinks(root) {
    root.querySelectorAll('a[href^="~/"], form[action^="~/"]').forEach(function (el) {
      var attr = el.tagName === 'FORM' ? 'action' : 'href';
      el.setAttribute(attr, u(el.getAttribute(attr).slice(1)));
    });
  }

  function mount() {
    var h = document.getElementById('site-header');
    if (h) h.outerHTML = header();
    var f = document.getElementById('site-footer');
    if (f) f.outerHTML = footer();
    rewriteLinks(document);

    var bar = document.getElementById('top-header');
    if (!bar) return;
    if (document.body.getAttribute('data-header') === 'over-dark') bar.classList.add('site-header--over-dark');
    var mobile = window.matchMedia('(max-width: 1080px)');
    var items = bar.querySelectorAll('.nav-item[data-menu]');
    var closeTimer;
    function closeAll(except) { items.forEach(function (it) { if (it !== except) { it.classList.remove('is-open'); it.querySelector('button').setAttribute('aria-expanded', 'false'); } }); }
    function sync() { var o = !!bar.querySelector('.nav-item.is-open'); if (o !== bar.classList.contains('menu-open')) bar.classList.toggle('menu-open', o); }
    new MutationObserver(sync).observe(bar, { subtree: true, attributes: true, attributeFilter: ['class'] });
    items.forEach(function (it) {
      var btn = it.querySelector('button');
      btn.addEventListener('click', function () {
        var open = !it.classList.contains('is-open') || (!mobile.matches && Date.now() - (it._hoverAt || 0) < 500);
        closeAll(it); it.classList.toggle('is-open', open); btn.setAttribute('aria-expanded', String(open));
      });
      it.addEventListener('mouseenter', function () { if (mobile.matches) return; clearTimeout(closeTimer); if (!it.classList.contains('is-open')) it._hoverAt = Date.now(); closeAll(it); it.classList.add('is-open'); btn.setAttribute('aria-expanded', 'true'); });
      it.addEventListener('mouseleave', function () { if (mobile.matches) return; closeTimer = setTimeout(function () { it.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); }, 160); });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
    document.addEventListener('click', function (e) { if (!bar.contains(e.target)) closeAll(); });
    bar.querySelector('.menu-toggle').addEventListener('click', function () {
      var open = bar.classList.toggle('is-open');
      document.documentElement.style.overflow = open ? 'hidden' : '';
    });
    function onScroll() { bar.classList.toggle('is-scrolled', window.scrollY > 8); }
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }

  function motion(root) {
    var els = (root || document).querySelectorAll('.reveal:not(.in), .mock:not(.in), [data-animate]:not(.in)');
    if (!('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); en.target.dispatchEvent(new CustomEvent('fm:in')); io.unobserve(en.target); }
      });
    }, { threshold: 0.18, rootMargin: '0px 0px -40px 0px' });
    els.forEach(function (e) { io.observe(e); });
    // Count-up numbers: <b data-count="1250" data-prefix="$" data-suffix="+">0</b>
    (root || document).querySelectorAll('[data-count]:not([data-counted])').forEach(function (el) {
      el.setAttribute('data-counted', '');
      var target = parseFloat(el.getAttribute('data-count')); var pre = el.getAttribute('data-prefix') || ''; var suf = el.getAttribute('data-suffix') || '';
      var dec = (el.getAttribute('data-count').split('.')[1] || '').length;
      var o = new IntersectionObserver(function (en) {
        if (!en[0].isIntersecting) return; o.disconnect();
        var t0 = performance.now();
        (function step(t) {
          var p = Math.min(1, (t - t0) / 1400); var v = target * (1 - Math.pow(1 - p, 3));
          el.textContent = pre + v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
          if (p < 1) requestAnimationFrame(step);
        })(t0);
      }, { threshold: .5 });
      o.observe(el);
    });
  }

  function head() {
    if (!document.querySelector('link[href*="font-awesome"]')) {
      var fa = document.createElement('link'); fa.rel = 'stylesheet';
      fa.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
      document.head.appendChild(fa);
    }
    if (!document.querySelector('meta[name="robots"]')) {
      var m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex, nofollow'; document.head.appendChild(m);
    }
  }

  window.FirstMateSite = { base: BASE, url: u, login: LOGIN, signup: SIGNUP, solutions: SOLUTIONS, rewriteLinks: rewriteLinks,
    // Restart every entry animation inside a .mock (e.g. for looping demos).
    // Call after adding .reveal/.mock elements from a page script.
    observe: function (root) { motion(root); },
    replay: function (el) { el.classList.remove('in'); void el.offsetWidth; el.classList.add('in'); } };
  head();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(); motion(); });
  else { mount(); motion(); }
})();
