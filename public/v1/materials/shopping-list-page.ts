/** The page a shopping list's public link opens: the list by supplier, with a box to tick per item when the link allows it. */
export function shoppingListAppHtml(token: string) {
  const tokenJson = JSON.stringify(token).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Shopping list</title>
  <style>
    :root{--brand:#2563eb;--ink:#101828;--muted:#667085;--line:#e4e7ec;--done:#12b76a;--paper:#fff;--bg:#f5f6f8}
    *{box-sizing:border-box}
    html,body{margin:0}
    body{background:var(--bg);color:var(--ink);font:15px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:0 0 48px}
    main{max-width:720px;margin:0 auto;padding:16px}
    header.top{display:flex;align-items:center;gap:12px;padding:8px 0 14px}
    header.top img{max-height:40px;max-width:160px;object-fit:contain}
    header.top .org{font-weight:800;font-size:14px}
    h1{margin:0;font-size:22px;letter-spacing:-.01em}
    .sub{color:var(--muted);font-size:13px;margin:4px 0 0}
    .notes{margin:12px 0 0;padding:10px 12px;border-radius:10px;background:#eff8ff;color:#1849a9;font-size:13px}
    .progress{position:sticky;top:0;z-index:2;margin:14px -16px 0;padding:10px 16px;background:rgba(245,246,248,.94);backdrop-filter:blur(6px);display:flex;align-items:center;gap:12px}
    .bar{flex:1;height:8px;border-radius:99px;background:var(--line);overflow:hidden}
    .bar>span{display:block;height:100%;background:var(--done);transition:width .25s ease}
    .count{font-weight:800;font-size:13px;white-space:nowrap}
    section.group{margin:16px 0 0;background:var(--paper);border:1px solid var(--line);border-radius:14px;overflow:hidden}
    section.group>h2{margin:0;padding:12px 14px;font-size:15px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:8px}
    section.group>h2 small{color:var(--muted);font-weight:600;font-size:12px}
    .addr{display:block;color:var(--muted);font-weight:500;font-size:12px;margin-top:2px}
    ul{list-style:none;margin:0;padding:0}
    li{border-top:1px solid var(--line)}
    li:first-child{border-top:0}
    label.item{display:grid;grid-template-columns:28px 52px minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px 14px;cursor:pointer;min-height:64px}
    label.item.readonly{cursor:default;grid-template-columns:52px minmax(0,1fr) auto}
    input[type=checkbox]{width:24px;height:24px;margin:0;accent-color:var(--done)}
    .thumb{width:52px;height:52px;border-radius:9px;background:#f2f4f7 center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#98a2b3;font-size:20px}
    .name{font-weight:700;overflow-wrap:anywhere}
    .details{color:var(--muted);font-size:12px;margin-top:2px;overflow-wrap:anywhere}
    .qty{font-weight:800;text-align:right;white-space:nowrap}
    li.done .name,li.done .details{text-decoration:line-through;color:#98a2b3}
    li.done .qty{color:var(--done)}
    li.saving{opacity:.6}
    .status{margin:24px 0;text-align:center;color:var(--muted)}
    .error{color:#b42318}
    .actions{display:flex;justify-content:flex-end;margin-top:14px}
    .actions button{border:1px solid var(--line);background:#fff;border-radius:9px;padding:8px 12px;font:inherit;font-weight:700;cursor:pointer}
    @media print{.progress,.actions{display:none}body{background:#fff}section.group{break-inside:avoid}}
  </style>
</head>
<body>
<main>
  <div id="app"><p class="status">Loading the shopping list…</p></div>
</main>
<script>
(function(){
  var token = ${tokenJson};
  var base = '/v1/materials/public/shopping-lists/' + encodeURIComponent(token);
  var state = null;
  var app = document.getElementById('app');
  function esc(value){ return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function qty(value){ var n = Number(value) || 0; return Math.round(n * 100) / 100; }
  function counts(){ var all = 0, done = 0; state.groups.forEach(function(g){ g.items.forEach(function(i){ all++; if (i.checked) done++; }); }); return { all: all, done: done }; }
  function renderProgress(){
    var c = counts();
    var bar = document.querySelector('.bar>span'); if (bar) bar.style.width = (c.all ? Math.round(c.done / c.all * 100) : 0) + '%';
    var count = document.querySelector('.count'); if (count) count.textContent = c.done + ' of ' + c.all + ' picked up';
  }
  function render(){
    var s = state;
    var org = s.organization || {};
    var html = '<header class="top">' + (org.logo_url ? '<img src="' + esc(org.logo_url) + '" alt="">' : '') + (org.name ? '<span class="org">' + esc(org.name) + '</span>' : '') + '</header>';
    html += '<h1>' + esc(s.title) + '</h1>';
    if (s.project && (s.project.title || s.project.address)) html += '<p class="sub">' + esc([s.project.title, s.project.address].filter(function(v, i, a){ return v && a.indexOf(v) === i; }).join(' · ')) + '</p>';
    if (s.notes) html += '<p class="notes">' + esc(s.notes) + '</p>';
    html += '<div class="progress"><div class="bar"><span></span></div><span class="count"></span></div>';
    s.groups.forEach(function(group){
      html += '<section class="group"><h2><span>' + esc(group.supplier || 'Materials') + (group.address ? '<span class="addr">' + esc(group.address) + '</span>' : '') + '</span><small>' + group.items.length + ' item' + (group.items.length === 1 ? '' : 's') + '</small></h2><ul>';
      group.items.forEach(function(item){
        var thumb = item.image_url ? '<span class="thumb" style="background-image:url(&quot;' + esc(item.image_url) + '&quot;)"></span>' : '<span class="thumb" aria-hidden="true">&#9638;</span>';
        var details = [item.sku ? 'SKU ' + item.sku : '', item.details].filter(Boolean).join(' · ');
        html += '<li class="' + (item.checked ? 'done' : '') + '" data-item="' + esc(item.id) + '"><label class="item' + (s.can_check ? '' : ' readonly') + '">' + (s.can_check ? '<input type="checkbox" ' + (item.checked ? 'checked' : '') + ' aria-label="Picked up ' + esc(item.name) + '">' : '') + thumb + '<span><div class="name">' + esc(item.name) + '</div>' + (details ? '<div class="details">' + esc(details) + '</div>' : '') + '</span><span class="qty">' + esc(qty(item.quantity)) + ' ' + esc(item.unit) + '</span></label></li>';
      });
      html += '</ul></section>';
    });
    html += '<div class="actions"><button type="button" data-print>Print</button></div>';
    app.innerHTML = html;
    renderProgress();
    app.querySelector('[data-print]').onclick = function(){ window.print(); };
    app.querySelectorAll('li[data-item] input[type=checkbox]').forEach(function(box){
      box.addEventListener('change', function(){ toggle(box.closest('li'), box); });
    });
  }
  function find(id){ var found = null; state.groups.forEach(function(g){ g.items.forEach(function(i){ if (i.id === id) found = i; }); }); return found; }
  function toggle(row, box){
    var item = find(row.dataset.item); if (!item) return;
    var next = box.checked;
    item.checked = next; row.classList.toggle('done', next); row.classList.add('saving'); renderProgress();
    fetch(base + '/items/' + encodeURIComponent(item.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: next }) })
      .then(function(r){ return r.json().then(function(body){ if (!r.ok || !body.ok) throw new Error((body && body.message) || 'Could not save'); return body; }); })
      .then(function(body){ item.checked = !!body.item.checked; })
      .catch(function(error){ item.checked = !next; box.checked = !next; row.classList.toggle('done', !next); alert(error.message || 'That change could not be saved. Check your connection and try again.'); })
      .then(function(){ row.classList.remove('saving'); renderProgress(); });
  }
  fetch(base, { headers: { Accept: 'application/json' } })
    .then(function(r){ return r.json().then(function(body){ if (!r.ok || !body.ok) throw new Error((body && body.message) || 'This shopping list is not available.'); return body; }); })
    .then(function(body){ state = body.shopping_list; document.title = state.title || 'Shopping list'; render(); })
    .catch(function(error){ app.innerHTML = '<p class="status error">' + esc(error.message) + '</p>'; });
})();
</script>
</body>
</html>`;
}
