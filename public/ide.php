<?php
// ide.php — Unified IDE: File Browser + Code Editor + Linting & Error Detection + Trash System
require_once __DIR__ . '/auth.php';
auth_require_login();
$fileParam = $_GET['file'] ?? '';
$dirParam  = $_GET['dir'] ?? '';
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IDE — <?= htmlspecialchars($fileParam ?: $dirParam ?: 'Workspace') ?></title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/material-darker.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/dialog/dialog.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/hint/show-hint.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/lint/lint.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/mode/simple.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/mode/multiplex.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/htmlmixed/htmlmixed.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/xml/xml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/javascript/javascript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/css/css.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/php/php.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/clike/clike.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/python/python.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/ruby/ruby.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/go/go.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/rust/rust.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/sql/sql.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/markdown/markdown.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/yaml/yaml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/shell/shell.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/toml/toml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/dockerfile/dockerfile.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/nginx/nginx.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/properties/properties.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/closebrackets.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/closetag.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/matchbrackets.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/matchtags.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/fold/xml-fold.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/selection/active-line.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/fold/foldcode.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/fold/foldgutter.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/fold/brace-fold.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/fold/indent-fold.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/fold/comment-fold.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/search/search.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/search/searchcursor.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/search/jump-to-line.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/dialog/dialog.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/search/matchesonscrollbar.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/scroll/annotatescrollbar.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/comment/comment.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/hint/show-hint.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/hint/anyword-hint.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/lint/lint.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0e14;--bg2:#0d1117;--bg3:#151b24;--bg4:#1a2130;
  --border:#1b2738;--border2:#263347;
  --text:#d4dce8;--text2:#8b9bb4;--text3:#5c6f85;
  --accent:#38bdf8;--accent2:#0ea5e9;--accent3:#0284c7;
  --green:#34d399;--red:#f87171;--yellow:#fbbf24;--purple:#a78bfa;--orange:#fb923c;
  --tab-bg:#0d1117;--tab-active:#0a0e14;--tab-hover:#141b25;
  --selection:rgba(56,189,248,0.12);--hover:rgba(56,189,248,0.06);
  --font:'DM Sans',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;
  --radius:8px;--radius-sm:5px;
  --shadow:0 8px 32px rgba(0,0,0,0.4);--shadow-sm:0 2px 8px rgba(0,0,0,0.3);
  --symlink:#c084fc;
}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.5}
::selection{background:rgba(56,189,248,0.15)}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}::-webkit-scrollbar-thumb:hover{background:var(--text3)}
a{color:var(--accent);text-decoration:none}
.app{display:flex;flex-direction:column;height:100vh}
.topbar{display:flex;align-items:center;height:38px;background:var(--bg2);border-bottom:1px solid var(--border);padding:0 12px;gap:10px;flex-shrink:0}
.main{display:flex;flex:1;overflow:hidden;min-height:0}
.sidebar{width:260px;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.content-area{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
.statusbar{display:flex;align-items:center;height:24px;background:var(--accent3);padding:0 12px;font-size:11px;color:rgba(255,255,255,.9);gap:16px;flex-shrink:0}
.statusbar .sep{width:1px;height:12px;background:rgba(255,255,255,.2)}
.logo{font-weight:700;font-size:14px;color:var(--accent);letter-spacing:-0.3px}
.logo span{color:var(--text3);font-weight:400;font-size:11px;margin-left:4px}
.topbar-actions{display:flex;gap:2px;margin-left:auto;align-items:center}
.topbar-user{font-size:11px;color:var(--text3);margin-right:4px}
.btn{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;background:transparent;border:1px solid transparent;border-radius:var(--radius-sm);color:var(--text2);font:11px var(--font);cursor:pointer;transition:all .12s;white-space:nowrap;text-decoration:none}
.btn:hover{background:var(--bg4);color:var(--text)}.btn.icon{padding:4px 6px}.btn.primary{background:var(--accent3);color:#fff}.btn.primary:hover{background:var(--accent2)}
.btn.danger{color:var(--red)}.btn.danger:hover{background:rgba(248,113,113,.1)}
.btn.active,.btn.toggled{background:var(--accent3);color:#fff}
.btn svg{width:14px;height:14px}
.btn[disabled]{opacity:.4;pointer-events:none}
.btn-group{display:flex}.btn-group .btn{border-radius:0}.btn-group .btn:first-child{border-radius:var(--radius-sm) 0 0 var(--radius-sm)}.btn-group .btn:last-child{border-radius:0 var(--radius-sm) var(--radius-sm) 0}.btn-group .btn+.btn{border-left:none}
.separator{width:1px;height:20px;background:var(--border);margin:0 4px}
.btn.lint-btn{position:relative;font-weight:500}
.btn.lint-btn .lint-badge{position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;font-size:9px;font-weight:700;line-height:16px;text-align:center}
.btn.lint-btn .lint-badge.errors{background:var(--red);color:#fff}
.btn.lint-btn .lint-badge.warnings{background:var(--yellow);color:#000}
.btn.lint-btn .lint-badge.ok{background:var(--green);color:#fff}
.btn.lint-btn.has-errors{color:var(--red);border-color:rgba(248,113,113,.3)}
.btn.lint-btn.has-warnings{color:var(--yellow);border-color:rgba(251,191,36,.3)}
.btn.lint-btn.lint-ok{color:var(--green);border-color:rgba(52,211,153,.3)}
/* Clipboard indicator */
.clipboard-indicator{display:none;align-items:center;gap:4px;padding:2px 8px;border-radius:var(--radius-sm);background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.25);color:var(--yellow);font-size:11px;cursor:pointer}
.clipboard-indicator:hover{background:rgba(251,191,36,.2)}
.clipboard-indicator.visible{display:inline-flex}
.clipboard-indicator.cut-mode{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.25);color:var(--red)}
.sidebar-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;border-bottom:1px solid var(--border)}
.sidebar-header .actions{display:flex;gap:2px}
.sidebar-search{padding:6px 8px;border-bottom:1px solid var(--border)}
.sidebar-search input{width:100%;padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font:11px var(--font);outline:none}
.sidebar-search input:focus{border-color:var(--accent)}
.sidebar-section{border-bottom:1px solid var(--border)}
.favorites{padding:4px 0;max-height:160px;overflow-y:auto}
.fav-item{display:flex;align-items:center;gap:6px;padding:4px 12px;cursor:pointer;font-size:12px;color:var(--text2);transition:all .1s;user-select:none}
.fav-item:hover{background:var(--hover);color:var(--text)}
.fav-item .fav-icon{font-size:13px;flex-shrink:0;display:flex;align-items:center}.fav-item .fav-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fav-item .fav-remove{opacity:0;color:var(--text3);font-size:14px;padding:0 4px;border-radius:3px;transition:all .1s}
.fav-item:hover .fav-remove{opacity:1}.fav-item .fav-remove:hover{color:var(--red);background:rgba(248,113,113,.1)}
.fav-empty{padding:8px 12px;font-size:11px;color:var(--text3);font-style:italic}
.tree{flex:1;overflow:auto;padding:2px 0}
.tree-item{display:flex;align-items:center;gap:3px;padding:3px 8px;cursor:pointer;font-size:12px;color:var(--text2);transition:all .08s;user-select:none;white-space:nowrap}
.tree-item:hover{background:rgba(56,189,248,.06);color:var(--text)}.tree-item.active{background:rgba(56,189,248,.1);color:var(--accent)}
.tree-item.drag-target{background:rgba(56,189,248,.15);outline:1px solid var(--accent)}
.tree-item .arrow{width:14px;flex-shrink:0;font-size:9px;color:var(--text3);transition:transform .12s;text-align:center}
.tree-item .arrow.open{transform:rotate(90deg)}.tree-item .arrow.hidden{visibility:hidden}
.tree-item .icon{flex-shrink:0;font-size:13px;width:18px;text-align:center;display:flex;align-items:center;justify-content:center}.tree-item .name{overflow:hidden;text-overflow:ellipsis}
.tree-item .tree-lint-badge{margin-left:auto;min-width:14px;height:14px;padding:0 3px;border-radius:7px;font-size:9px;font-weight:700;line-height:14px;text-align:center;flex-shrink:0}
.tree-item .tree-lint-badge.err{background:rgba(248,113,113,.2);color:var(--red)}
.tree-item .tree-lint-badge.warn{background:rgba(251,191,36,.2);color:var(--yellow)}
.tree-item.is-symlink .name{color:var(--symlink);font-style:italic}
.tree-item.is-symlink .symlink-arrow{color:var(--symlink);font-size:10px;margin-left:2px;flex-shrink:0;opacity:.85}
.tree-item.is-symlink .icon{position:relative}
.tree-item.is-symlink .icon .sl-overlay{position:absolute;bottom:-2px;right:-4px;font-size:7px;line-height:1;filter:drop-shadow(0 0 1px var(--bg2))}
.symlink-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:15px;border-radius:3px;background:rgba(192,132,252,.18);color:var(--symlink);font-size:9px;font-weight:700;flex-shrink:0;margin-left:3px;line-height:1;padding:0 3px;gap:2px}
.symlink-badge.dir-link{background:rgba(192,132,252,.22);border:1px solid rgba(192,132,252,.3);font-size:8px;padding:1px 4px}
.file-table .symlink-name{color:var(--symlink);font-style:italic}
.file-table .symlink-target{color:var(--text3);font-size:10px;font-style:italic;margin-left:6px;max-width:180px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:middle}
.file-table tr.is-symlink-row{background:rgba(192,132,252,.03)}
.file-table tr.is-symlink-row:hover{background:rgba(192,132,252,.07)}
.file-table tr.is-symlink-row.selected{background:rgba(192,132,252,.12)}
.file-card.is-symlink{border-color:rgba(192,132,252,.3);background:rgba(192,132,252,.03)}
.file-card.is-symlink .file-name{color:var(--symlink);font-style:italic}
.file-card.is-symlink .file-icon{position:relative}
.file-card.is-symlink .sl-overlay-grid{position:absolute;bottom:0;right:2px;font-size:11px;filter:drop-shadow(0 0 2px var(--bg))}
.tab.is-symlink .tab-title{color:var(--symlink);font-style:italic}
.symlink-indicator{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:var(--symlink);background:rgba(192,132,252,.1);border:1px solid rgba(192,132,252,.2);padding:1px 6px;border-radius:10px;margin-left:4px;flex-shrink:0;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
.symlink-indicator .si-arrow{font-size:11px}
.modal .symlink-field-group{display:flex;flex-direction:column;gap:12px;margin-top:8px}
.modal .symlink-field-group label{margin-bottom:0}
.modal .symlink-field-group input{margin-top:4px}
.modal .symlink-toggle{display:flex;align-items:center;gap:8px;margin-top:4px;font-size:12px;color:var(--text2)}
.modal .symlink-toggle input[type="checkbox"]{appearance:none;-webkit-appearance:none;width:16px;height:16px;border:1px solid var(--border2);border-radius:4px;background:var(--bg);cursor:pointer;position:relative;flex-shrink:0}
.modal .symlink-toggle input[type="checkbox"]:checked{background:var(--symlink);border-color:var(--symlink)}
.modal .symlink-toggle input[type="checkbox"]:checked::after{content:'\2713';position:absolute;top:-1px;left:2px;font-size:11px;color:#fff;font-weight:bold}
.modal .symlink-info-box{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-top:8px;font-size:11px;line-height:1.5}
.modal .symlink-info-box .si-label{color:var(--text3);font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.5px}
.modal .symlink-info-box .si-value{color:var(--symlink);font-family:var(--mono);font-size:11px;word-break:break-all;margin-top:2px}
.modal .symlink-info-box .si-status{margin-top:6px;display:flex;align-items:center;gap:6px;font-size:11px}
.modal .symlink-info-box .si-status.valid{color:var(--green)}
.modal .symlink-info-box .si-status.broken{color:var(--red)}
.info-panel .info-symlink{margin-top:12px;padding:10px;background:rgba(192,132,252,.06);border:1px solid rgba(192,132,252,.15);border-radius:6px}
.info-panel .info-symlink .isl-title{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--symlink);margin-bottom:6px;display:flex;align-items:center;gap:4px}
.info-panel .info-symlink .isl-target{font-family:var(--mono);font-size:11px;color:var(--text);word-break:break-all;padding:4px 6px;background:var(--bg);border-radius:4px}
.info-panel .info-symlink .isl-status{font-size:11px;margin-top:6px;display:flex;align-items:center;gap:4px}
.info-panel .info-symlink .isl-status.valid{color:var(--green)}
.info-panel .info-symlink .isl-status.broken{color:var(--red)}
.info-panel .info-symlink .isl-actions{display:flex;gap:4px;margin-top:8px}
.tree-item.is-symlink.broken-symlink .name{color:var(--red);text-decoration:line-through;text-decoration-color:rgba(248,113,113,.5)}
.file-table .symlink-name.broken{color:var(--red);text-decoration:line-through;text-decoration-color:rgba(248,113,113,.5)}
.file-card.is-symlink.broken-symlink .file-name{color:var(--red);text-decoration:line-through;text-decoration-color:rgba(248,113,113,.5)}
/* Cut items visual */
.file-table tr.is-cut-item td,.file-table tr.is-cut-item .fname{opacity:.45}
.file-card.is-cut-item{opacity:.45}
.tab-bar-wrap{display:flex;align-items:stretch;background:var(--tab-bg);border-bottom:1px solid var(--border);height:36px;flex-shrink:0}
.tab-bar{display:flex;align-items:stretch;flex:1;overflow-x:auto;min-width:0}
.tab-bar::-webkit-scrollbar{height:0}
.tab-new-btn{display:flex;align-items:center;justify-content:center;width:36px;background:transparent;border:none;border-left:1px solid var(--border);color:var(--text3);cursor:pointer;font-size:18px;font-weight:300;line-height:1;transition:all .12s;flex-shrink:0;font-family:inherit;padding:0}
.tab-new-btn:hover{background:var(--tab-hover);color:var(--accent)}
.tab-new-btn:active{background:var(--bg4)}
/* URL bar in topbar */
.url-bar{display:flex;align-items:center;gap:6px;flex:1;max-width:760px;min-width:200px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:3px 4px 3px 8px;transition:border-color .15s,background .15s}
.url-bar:hover{border-color:var(--border2)}
.url-bar:focus-within{border-color:var(--accent);background:var(--bg3)}
.url-bar .url-icon{color:var(--text3);flex-shrink:0;display:flex;align-items:center}
.url-bar input{flex:1;background:transparent;border:none;outline:none;color:var(--text);font:11px var(--mono);padding:3px 2px;min-width:0}
.url-bar input::placeholder{color:var(--text3);font-family:var(--font)}
.url-bar input::selection{background:rgba(56,189,248,0.25)}
.url-bar .url-go{background:transparent;border:none;color:var(--text3);cursor:pointer;padding:3px 6px;border-radius:3px;flex-shrink:0;display:flex;align-items:center;transition:all .12s}
.url-bar .url-go:hover{background:var(--bg4);color:var(--accent)}
.url-bar .url-go svg{width:13px;height:13px}
.tab{display:flex;align-items:center;gap:6px;padding:0 14px;height:100%;border-right:1px solid var(--border);cursor:pointer;font-size:12px;color:var(--text2);transition:all .1s;position:relative;user-select:none;min-width:0;max-width:220px;flex-shrink:0}
.tab:hover{background:var(--tab-hover)}.tab.active{background:var(--tab-active);color:var(--text);border-bottom:2px solid var(--accent)}
.tab.modified .tab-title::after{content:'\25CF';margin-left:4px;color:var(--orange);font-size:8px}
.tab.has-errors{border-bottom-color:var(--red) !important}
.tab.has-warnings:not(.has-errors){border-bottom-color:var(--yellow) !important}
.tab .tab-icon{font-size:12px;flex-shrink:0}.tab .tab-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tab .tab-close{width:16px;height:16px;display:flex;align-items:center;justify-content:center;border-radius:3px;font-size:14px;color:var(--text3);flex-shrink:0;transition:all .1s}
.tab .tab-close:hover{background:rgba(248,113,113,.2);color:var(--red)}
.tab[draggable="true"]{cursor:grab}.tab[draggable="true"]:active{cursor:grabbing}
.tab.tab-drop-left{box-shadow:inset 3px 0 0 var(--accent)}.tab.tab-drop-right{box-shadow:inset -3px 0 0 var(--accent)}
.tab.dragging{opacity:.4}
.tab .tab-type{font-size:9px;color:var(--text3);background:var(--bg3);padding:1px 4px;border-radius:3px;margin-right:2px;flex-shrink:0}
.tab .tab-err-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}.tab .tab-err-dot.e{background:var(--red)}.tab .tab-err-dot.w{background:var(--yellow)}
.editor-view{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
.editor-wrap{flex:1;position:relative;overflow:hidden;display:flex;min-height:0}
.editor-cm{flex:1;overflow:hidden;min-height:0}
.CodeMirror{height:100% !important;font-family:var(--mono) !important;font-size:13px !important;line-height:1.6 !important;background:var(--bg) !important}
.CodeMirror-gutters{background:var(--bg) !important;border-right:1px solid var(--border) !important}
.CodeMirror-linenumber{color:var(--text3) !important;font-size:11px !important;padding:0 8px 0 12px !important}
.CodeMirror-activeline-background{background:rgba(56,189,248,.04) !important}
.CodeMirror-selected{background:rgba(56,189,248,.15) !important}
.CodeMirror-focused .CodeMirror-selected{background:rgba(56,189,248,.2) !important}
.CodeMirror-cursor{border-left:2px solid var(--accent) !important}
.CodeMirror-matchingbracket{color:var(--green) !important;border-bottom:1px solid var(--green) !important;background:transparent !important}
.CodeMirror-nonmatchingbracket{color:var(--red) !important;border-bottom:2px solid var(--red) !important;background:rgba(248,113,113,.15) !important}
.CodeMirror-foldmarker{color:var(--accent) !important;text-shadow:none !important;font-family:var(--mono) !important}
.CodeMirror-foldgutter-folded,.CodeMirror-foldgutter-open{color:var(--text3) !important}
.cm-s-material-darker .cm-keyword{color:#c792ea !important}.cm-s-material-darker .cm-atom{color:#f78c6c !important}
.cm-s-material-darker .cm-number{color:#f78c6c !important}.cm-s-material-darker .cm-string{color:#c3e88d !important}
.cm-s-material-darker .cm-string-2{color:#89ddff !important}.cm-s-material-darker .cm-variable{color:#eeffff !important}
.cm-s-material-darker .cm-variable-2{color:#82aaff !important}.cm-s-material-darker .cm-def{color:#82aaff !important}
.cm-s-material-darker .cm-comment{color:#546e7a !important;font-style:italic !important}
.cm-s-material-darker .cm-tag{color:#f07178 !important}.cm-s-material-darker .cm-attribute{color:#c792ea !important}
.cm-s-material-darker .cm-property{color:#89ddff !important}.cm-s-material-darker .cm-operator{color:#89ddff !important}
.cm-s-material-darker .cm-type{color:#ffcb6b !important}.cm-s-material-darker .cm-meta{color:#ff5370 !important}
.CodeMirror-dialog{background:var(--bg3) !important;color:var(--text) !important;border-bottom:1px solid var(--border) !important;padding:6px 12px !important;font-family:var(--font) !important;font-size:12px !important}
.CodeMirror-dialog input{background:var(--bg) !important;color:var(--text) !important;border:1px solid var(--border) !important;padding:4px 8px !important;border-radius:4px !important;font:12px var(--mono) !important;outline:none !important}
.CodeMirror-dialog input:focus{border-color:var(--accent) !important}
.cm-find-match{background:rgba(251,191,36,0.25) !important;outline:1px solid rgba(251,191,36,0.6);border-radius:1px}
.cm-find-match-current{background:rgba(251,191,36,0.55) !important;outline:2px solid var(--yellow);border-radius:1px}
.lint-gutter{width:16px;cursor:pointer}
.lint-marker{width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-size:9px;font-weight:700;cursor:pointer}
.lint-marker.e{background:var(--red);color:#fff}.lint-marker.w{background:var(--yellow);color:#000}
.lint-error-line{background:rgba(248,113,113,.08) !important}
.lint-warning-line{background:rgba(251,191,36,.06) !important}
.lint-tooltip{position:fixed;z-index:1100;max-width:480px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;box-shadow:var(--shadow);font-family:var(--font);overflow:hidden}
.lint-tooltip-item{padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px;display:flex;gap:8px;align-items:flex-start}
.lint-tooltip-item:last-child{border-bottom:none}
.lint-tooltip-icon{width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;flex-shrink:0;margin-top:2px}
.lint-tooltip-icon.e{background:var(--red);color:#fff}.lint-tooltip-icon.w{background:var(--yellow);color:#000}
.lint-tooltip-msg{flex:1;color:var(--text);line-height:1.4}.lint-tooltip-src{color:var(--text3);font-size:10px;margin-top:2px}
.problems-panel{background:var(--bg2);border-top:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;overflow:hidden}
.problems-panel.collapsed{height:28px !important}
.problems-header{display:flex;align-items:center;height:28px;padding:0 12px;gap:8px;cursor:pointer;user-select:none;flex-shrink:0;border-bottom:1px solid var(--border)}
.problems-header:hover{background:var(--hover)}
.problems-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);display:flex;align-items:center;gap:6px}
.problems-title .cnt{padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700}
.problems-title .cnt.e{background:rgba(248,113,113,.15);color:var(--red)}
.problems-title .cnt.w{background:rgba(251,191,36,.15);color:var(--yellow)}
.problems-title .cnt.ok{background:rgba(52,211,153,.15);color:var(--green)}
.problems-actions{margin-left:auto;display:flex;gap:4px;align-items:center}
.problems-toggle{color:var(--text3);font-size:12px;transition:transform .15s}
.problems-panel.collapsed .problems-toggle{transform:rotate(180deg)}
.problems-list{flex:1;overflow:auto;padding:2px 0}
.problems-list:empty::after{content:'No problems detected \2713';display:block;padding:16px;text-align:center;color:var(--green);font-size:12px}
.prob-item{display:flex;align-items:flex-start;gap:8px;padding:4px 12px;cursor:pointer;font-size:12px;transition:background .08s;border-left:3px solid transparent}
.prob-item:hover{background:var(--hover)}
.prob-item.e{border-left-color:var(--red)}.prob-item.w{border-left-color:var(--yellow)}
.prob-item .p-icon{width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;flex-shrink:0;margin-top:2px}
.prob-item .p-icon.e{background:var(--red);color:#fff}.prob-item .p-icon.w{background:var(--yellow);color:#000}
.prob-item .p-msg{flex:1;color:var(--text2);line-height:1.4;word-break:break-word}
.prob-item .p-src{color:var(--text3);font-size:10px;margin-left:4px}
.prob-item .p-loc{flex-shrink:0;color:var(--text3);font-family:var(--mono);font-size:10px;min-width:50px;text-align:right;margin-top:2px}
.prob-item .p-file{flex-shrink:0;color:var(--accent);font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.problems-resize{height:4px;background:transparent;cursor:ns-resize;flex-shrink:0}.problems-resize:hover,.problems-resize.active{background:var(--accent)}
.minimap-err{position:absolute;left:0;right:0;height:3px;pointer-events:none;z-index:5}
.minimap-err.e{background:rgba(248,113,113,.6)}.minimap-err.w{background:rgba(251,191,36,.4)}
.minimap{width:120px;background:var(--bg);border-left:1px solid var(--border);position:relative;cursor:pointer;flex-shrink:0;overflow:hidden}
.minimap canvas{display:block;position:absolute;top:0;left:0;width:100%;image-rendering:pixelated;will-change:top}
.minimap .viewport{position:absolute;left:0;right:0;background:rgba(56,189,248,.12);border-top:2px solid rgba(56,189,248,.5);border-bottom:2px solid rgba(56,189,248,.5);border-left:3px solid var(--accent);box-shadow:0 0 12px rgba(56,189,248,.15);pointer-events:none;min-height:24px;will-change:top,height;transition:none}
.find-bar{display:none;padding:8px 12px;background:var(--bg3);border-bottom:1px solid var(--border);gap:8px;align-items:center;flex-shrink:0}
.find-bar.visible{display:flex}
.find-bar input{padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font:12px var(--mono);outline:none;width:200px}
.find-bar input:focus{border-color:var(--accent)}
.find-bar .find-info{font-size:11px;color:var(--text3);min-width:60px}
.find-bar .close-find{cursor:pointer;color:var(--text3);font-size:16px;padding:2px 6px;border-radius:3px}
.find-bar .close-find:hover{background:var(--bg4);color:var(--text)}
.find-bar .auto-find-toggle{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;color:var(--text3);user-select:none}
.find-bar .auto-find-toggle:hover{color:var(--text2)}
.find-bar .auto-find-toggle input[type="checkbox"]{appearance:none;-webkit-appearance:none;width:13px;height:13px;border:1px solid var(--border2);border-radius:3px;background:var(--bg);cursor:pointer;position:relative;flex-shrink:0}
.find-bar .auto-find-toggle input[type="checkbox"]:checked{background:var(--accent3);border-color:var(--accent2)}
.find-bar .auto-find-toggle input[type="checkbox"]:checked::after{content:'\2713';position:absolute;top:-1px;left:1px;font-size:10px;color:#fff;font-weight:bold}
.browser-view{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
.browser-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
.browser-breadcrumb{display:flex;align-items:center;gap:2px;flex:1;overflow-x:auto;white-space:nowrap;padding:0 4px}
.browser-breadcrumb a,.browser-breadcrumb span{padding:3px 6px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
.browser-breadcrumb a{color:var(--text2)}.browser-breadcrumb a:hover{background:var(--hover);color:var(--text)}
.browser-breadcrumb .bsep{color:var(--text3);padding:0 2px;cursor:default}.browser-breadcrumb .bcurrent{color:var(--text);font-weight:600}
.browser-search{position:relative;width:200px}
.browser-search input{width:100%;padding:5px 10px 5px 28px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font:11px var(--font);outline:none}
.browser-search input:focus{border-color:var(--accent)}
.browser-search svg{position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--text3)}
.browser-filelist{flex:1;overflow:auto;padding:8px}
.action-bar{display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--bg2);border-bottom:1px solid var(--border);color:#fff;font-size:11px;flex-shrink:0;min-height:33px}
.action-bar>*{opacity:0;pointer-events:none;transition:opacity .12s}
.action-bar.visible{background:var(--accent3);border-bottom-color:var(--accent2)}
.action-bar.visible>*{opacity:1;pointer-events:auto}
.action-bar .action-count{font-weight:600;margin-right:8px}
.action-bar .btn{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.2);color:#fff;font-size:11px}.action-bar .btn:hover{background:rgba(255,255,255,.22)}
.file-table{width:100%;border-collapse:collapse}
.file-table th{position:sticky;top:0;background:var(--bg2);text-align:left;padding:5px 12px;font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);cursor:pointer;user-select:none;white-space:nowrap;z-index:2}
.file-table th:hover{color:var(--text2)}.file-table th.sorted{color:var(--accent)}.file-table th .sort-arrow{margin-left:4px;font-size:10px}
.file-table td{padding:4px 12px;border-bottom:1px solid var(--border);font-size:12px;white-space:nowrap}
.file-table tr{cursor:pointer;transition:background .1s}
.file-table tbody tr:hover{background:var(--hover)}.file-table tbody tr.selected{background:var(--selection)}
.file-table tbody tr.drag-target{background:rgba(56,189,248,.12);outline:2px solid var(--accent);outline-offset:-2px}
.file-table .name-cell{display:flex;align-items:center;gap:8px}.file-table .name-cell .ficon{font-size:15px;flex-shrink:0;width:20px;height:20px;display:flex;align-items:center;justify-content:center}.file-table .name-cell .fname{overflow:hidden;text-overflow:ellipsis}
.file-table .muted{color:var(--text3)}
.file-table .fav-star{color:transparent;cursor:pointer;font-size:13px;transition:color .15s}
.file-table .fav-star:hover{color:var(--yellow)}.file-table .fav-star.active{color:var(--yellow)}
.file-table tr[draggable="true"]{cursor:grab}
.thumb{width:20px;height:20px;object-fit:cover;border-radius:3px;vertical-align:middle;flex-shrink:0;background:var(--bg3)}
.file-card .thumb-lg{width:48px;height:48px;object-fit:cover;border-radius:6px;background:var(--bg3)}
.tree-item .thumb-sm{width:16px;height:16px;object-fit:cover;border-radius:2px;vertical-align:middle;background:var(--bg3)}
.tab .thumb-tab{width:14px;height:14px;object-fit:cover;border-radius:2px;vertical-align:middle;background:var(--bg3)}
.file-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:4px;padding:4px}
.file-card{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 6px;border-radius:var(--radius);cursor:grab;user-select:none;transition:all .1s;border:2px solid transparent;position:relative}
.file-card:hover{background:var(--hover)}.file-card.selected{background:var(--selection);border-color:var(--accent)}
.file-card .file-icon{font-size:32px;line-height:1;transition:transform .15s;width:48px;height:48px;display:flex;align-items:center;justify-content:center}.file-card:hover .file-icon{transform:scale(1.05)}
.file-card .file-name{font-size:11px;text-align:center;word-break:break-all;line-height:1.3;max-height:2.6em;overflow:hidden;width:100%}
.welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text3);gap:12px;padding:40px;width:100%}
.welcome h2{font-size:20px;color:var(--text2);font-weight:300}
.shortcuts{display:grid;grid-template-columns:auto auto;gap:6px 20px;margin-top:16px;font-size:12px}
.shortcuts .key{font-family:var(--mono);background:var(--bg3);padding:2px 8px;border-radius:4px;border:1px solid var(--border);color:var(--accent);text-align:right}
.shortcuts .desc{color:var(--text2)}
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;color:var(--text3)}
.empty-state .empty-icon{font-size:48px;margin-bottom:12px;opacity:.5}
.context-menu{position:fixed;z-index:1000;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--radius);padding:4px;min-width:200px;box-shadow:var(--shadow);animation:menuIn .12s ease}
@keyframes menuIn{from{opacity:0;transform:scale(.96) translateY(-4px)}to{opacity:1;transform:none}}
.menu-item{display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:var(--radius-sm);font-size:12px;cursor:pointer;transition:background .1s;color:var(--text)}
.menu-item:hover{background:var(--accent3);color:#fff}.menu-item.danger{color:var(--red)}.menu-item.danger:hover{background:rgba(248,113,113,.15);color:var(--red)}
.menu-item .shortcut{margin-left:auto;font-size:10px;color:var(--text3);font-family:var(--mono)}.menu-item:hover .shortcut{color:rgba(255,255,255,.5)}
.menu-item .mi{width:18px;text-align:center;flex-shrink:0;font-size:13px}
.menu-item.disabled{opacity:.4;pointer-events:none}
.menu-divider{height:1px;background:var(--border);margin:4px 0}
.palette-overlay{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5);display:flex;align-items:flex-start;justify-content:center;padding-top:80px}
.palette{width:500px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;box-shadow:0 16px 48px rgba(0,0,0,.5);overflow:hidden;animation:palIn .12s ease}
@keyframes palIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1}}
.palette input{width:100%;padding:12px 16px;background:transparent;border:none;border-bottom:1px solid var(--border);color:var(--text);font:14px var(--font);outline:none}
.palette-results{max-height:300px;overflow-y:auto}
.palette-item{display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer;font-size:13px;color:var(--text2);transition:background .08s}
.palette-item:hover,.palette-item.active{background:rgba(56,189,248,.1);color:var(--text)}
.palette-item .pi-icon{width:20px;text-align:center;font-size:14px}.palette-item .pi-label{flex:1}
.palette-item .pi-shortcut{font-size:10px;color:var(--text3);font-family:var(--mono)}
.preview-overlay{position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:950;display:flex;align-items:center;justify-content:center;animation:fadeIn .15s;cursor:pointer}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.preview-container{max-width:90vw;max-height:90vh;position:relative;cursor:default;display:flex;flex-direction:column;align-items:center}
.preview-container img,.preview-container video{max-width:90vw;max-height:82vh;border-radius:8px;box-shadow:var(--shadow)}
.preview-container iframe{width:80vw;height:82vh;border:none;border-radius:8px}
.preview-header{display:flex;align-items:center;gap:12px;padding:8px 0;color:var(--text2);font-size:13px;width:100%}
.preview-close{position:fixed;top:16px;right:20px;color:var(--text2);font-size:28px;cursor:pointer;padding:4px 10px;border-radius:6px;z-index:960}
.preview-close:hover{color:#fff;background:rgba(255,255,255,.1)}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:900;display:flex;align-items:center;justify-content:center;animation:fadeIn .15s}
.modal{background:var(--bg3);border:1px solid var(--border2);border-radius:12px;min-width:400px;max-width:540px;box-shadow:var(--shadow);animation:modalIn .2s ease}
@keyframes modalIn{from{opacity:0;transform:scale(.95) translateY(8px)}to{opacity:1;transform:none}}
.modal-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border)}
.modal-header h3{font-size:15px;font-weight:600}
.modal-body{padding:20px}
.modal-footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--border)}
.modal input[type="text"]{width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius-sm);color:var(--text);font:13px var(--font);outline:none;transition:border .2s}
.modal input[type="text"]:focus{border-color:var(--accent)}
.modal label{display:block;font-size:12px;color:var(--text2);margin-bottom:6px}
.toast-container{position:fixed;bottom:32px;right:16px;z-index:2000;display:flex;flex-direction:column;gap:6px}
.toast{padding:8px 14px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.3);animation:toastIn .2s ease;display:flex;align-items:center;gap:6px}
@keyframes toastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1}}
.toast.success{border-color:var(--green);color:var(--green)}.toast.error{border-color:var(--red);color:var(--red)}.toast.info{border-color:var(--accent);color:var(--accent)}
.task-tray{position:fixed;right:16px;bottom:72px;z-index:1800;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 112px);display:flex;flex-direction:column;gap:8px;overflow-y:auto;pointer-events:none}
.task-card{pointer-events:auto;background:rgba(21,27,36,.96);border:1px solid var(--border2);border-radius:8px;box-shadow:var(--shadow-sm);overflow:hidden;animation:taskIn .16s ease;backdrop-filter:blur(10px)}
@keyframes taskIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.task-card.running{border-color:rgba(56,189,248,.35)}.task-card.success{border-color:rgba(52,211,153,.35)}.task-card.error{border-color:rgba(248,113,113,.4)}
.task-head{display:flex;align-items:center;gap:9px;padding:10px 10px 8px}
.task-icon{width:18px;height:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--text2)}
.task-spinner{width:14px;height:14px;border:2px solid rgba(56,189,248,.22);border-top-color:var(--accent);border-radius:50%;animation:spin .75s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.task-title{flex:1;min-width:0}.task-title strong{display:block;font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-title span{display:block;font-size:10px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-actions{display:flex;gap:2px;flex-shrink:0}.task-btn{width:22px;height:22px;border:0;background:transparent;color:var(--text3);border-radius:4px;cursor:pointer;font-size:13px;line-height:22px}.task-btn:hover{background:var(--bg4);color:var(--text)}
.task-body{padding:0 10px 10px 37px;font-size:11px;color:var(--text2);line-height:1.45}.task-result{margin-top:5px;font:600 18px var(--mono);color:var(--green)}.task-card.error .task-result{color:var(--red);font-size:13px}.task-meta{margin-top:3px;color:var(--text3);font-size:10px}.task-card.minimized .task-body{display:none}.task-card.minimized .task-head{padding-bottom:10px}
@media (max-width:720px){.task-tray{left:12px;right:12px;bottom:58px;width:auto}.toast-container{left:12px;right:12px;bottom:12px}.toast{justify-content:center}}
.drop-overlay{position:fixed;inset:0;z-index:800;background:rgba(10,14,20,.85);display:none;align-items:center;justify-content:center;pointer-events:none}
.drop-overlay.active{display:flex}
.drop-box{border:2px dashed var(--accent);border-radius:16px;padding:60px;text-align:center;color:var(--accent);font-size:18px;font-weight:600}
.info-panel{width:260px;background:var(--bg2);border-left:1px solid var(--border);padding:16px;overflow-y:auto;flex-shrink:0;display:none}
.info-panel.visible{display:block}
.info-panel h4{font-size:13px;font-weight:600;margin-bottom:12px}
.info-panel .info-icon{font-size:48px;text-align:center;margin:8px 0 16px}
.info-panel .info-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px}
.info-panel .info-label{color:var(--text3)}.info-panel .info-value{color:var(--text2);font-family:var(--mono);font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;text-align:right}
.info-panel .preview-thumb{width:100%;border-radius:6px;margin:8px 0;max-height:180px;object-fit:contain;background:var(--bg)}
.trash-dock{position:sticky;bottom:0;z-index:10;display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg2);border-top:1px solid var(--border);cursor:pointer;user-select:none;transition:all .15s;flex-shrink:0}
.trash-dock:hover{background:var(--bg3)}
.trash-dock.drag-hover{background:rgba(248,113,113,.12);border-top-color:var(--red);outline:2px dashed var(--red);outline-offset:-2px}
.trash-dock .trash-icon{font-size:16px;flex-shrink:0;transition:transform .15s}
.trash-dock:hover .trash-icon{transform:scale(1.1)}
.trash-dock.drag-hover .trash-icon{transform:scale(1.2)}
.trash-dock .trash-label{font-size:12px;font-weight:500;color:var(--text2);flex:1}
.trash-dock.has-items .trash-label{color:var(--text)}
.trash-dock .trash-count{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--bg4);color:var(--text3);font-size:10px;font-weight:700;line-height:18px;text-align:center;flex-shrink:0;transition:all .15s}
.trash-dock.has-items .trash-count{background:rgba(248,113,113,.15);color:var(--red)}
.trash-dock .trash-size{font-size:10px;color:var(--text3);flex-shrink:0}
.trash-view{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
.trash-toolbar{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
.trash-toolbar h3{font-size:14px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px}
.trash-toolbar h3 .trash-total-badge{font-size:11px;font-weight:500;color:var(--text2);background:var(--bg4);padding:2px 8px;border-radius:10px}
.trash-stats-bar{display:flex;align-items:center;gap:12px;padding:6px 16px;background:var(--bg);border-bottom:1px solid var(--border);font-size:11px;color:var(--text3);flex-shrink:0}
.trash-stats-bar .ts-item{display:flex;align-items:center;gap:4px}
.trash-stats-bar .ts-value{color:var(--text2);font-weight:600;font-family:var(--mono)}
.trash-stats-bar .ts-sep{width:1px;height:12px;background:var(--border2)}
.trash-action-bar{display:none;align-items:center;gap:8px;padding:6px 16px;background:rgba(248,113,113,.08);border-bottom:1px solid rgba(248,113,113,.2);font-size:11px;flex-shrink:0}
.trash-action-bar.visible{display:flex}
.trash-action-bar .ta-count{font-weight:600;color:var(--red)}
.trash-list{flex:1;overflow:auto;padding:4px 0}
.trash-list:empty::after{content:'Trash is empty';display:flex;align-items:center;justify-content:center;height:100%;color:var(--text3);font-size:14px;opacity:.6}
.trash-item{display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid var(--border);transition:background .1s;cursor:pointer;user-select:none}
.trash-item:hover{background:var(--hover)}
.trash-item.selected{background:var(--selection)}
.trash-item .ti-check{width:16px;height:16px;border:1.5px solid var(--border2);border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .12s;cursor:pointer}
.trash-item.selected .ti-check{background:var(--accent3);border-color:var(--accent2);color:#fff;font-size:10px}
.trash-item .ti-icon{font-size:18px;flex-shrink:0;width:24px;text-align:center}
.trash-item .ti-info{flex:1;min-width:0}
.trash-item .ti-name{font-size:12px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trash-item .ti-path{font-size:10px;color:var(--text3);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.trash-item .ti-meta{display:flex;align-items:center;gap:12px;flex-shrink:0}
.trash-item .ti-size{font-size:11px;color:var(--text3);font-family:var(--mono);min-width:60px;text-align:right}
.trash-item .ti-date{font-size:10px;color:var(--text3);min-width:80px;text-align:right}
.trash-item .ti-ago{font-size:10px;color:var(--text3);min-width:50px;text-align:right;font-style:italic}
.trash-item .ti-actions{display:flex;gap:4px;flex-shrink:0;opacity:0;transition:opacity .15s}
.trash-item:hover .ti-actions{opacity:1}
.trash-item .ti-actions .btn{padding:3px 8px;font-size:10px}
.trash-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--text3)}
.trash-empty-state .tes-icon{font-size:56px;opacity:.4}
.trash-empty-state .tes-text{font-size:14px}
.trash-empty-state .tes-sub{font-size:11px;opacity:.6}
.trash-search{position:relative;width:200px}
.trash-search input{width:100%;padding:5px 10px 5px 28px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font:11px var(--font);outline:none}
.trash-search input:focus{border-color:var(--accent)}
.trash-search svg{position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--text3)}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="logo">IDE<span>Workspace</span></div>
    <span class="topbar-user">&#128100; <?= htmlspecialchars(auth_get_user() ?? '') ?></span>
    <div class="url-bar" id="urlBarWrap" title="Path bar &mdash; type a file or directory and press Enter (Ctrl+L to focus)">
      <span class="url-icon" id="urlIcon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
      </span>
      <input type="text" id="urlBar" placeholder="/ &mdash; type a path and press Enter" spellcheck="false" autocomplete="off">
      <button class="url-go" id="urlGoBtn" onclick="urlBarNavigate()" title="Go (Enter)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
    <div class="topbar-actions">
      <button class="btn" onclick="openBrowserTab('')" title="Browse root folder">&#128194; Browse</button>
      <button class="btn lint-btn" id="lintBtn" onclick="lintCurrentFile()" title="Lint file (Ctrl+Shift+L)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
        Lint<span class="lint-badge" id="lintBadge" style="display:none"></span>
      </button>
      <button class="btn" id="downloadBtn" onclick="downloadCurrentFile()" title="Download current file (Ctrl+D)" style="display:none">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download
      </button>
      <span class="clipboard-indicator" id="clipboardIndicator" onclick="clearClipboard()" title="Click to clear clipboard"></span>
      <button class="btn" onclick="openPalette()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>Commands</button>
      <a href="login.php?logout=1" class="btn danger" style="font-size:11px">Logout</a>
    </div>
  </div>
  <div class="main">
    <div class="sidebar" id="sidebar">
      <div class="sidebar-section" id="favSection">
        <div class="sidebar-header">&#11088; Favorites <button class="btn icon" onclick="clearAllFavorites()" title="Clear all" style="padding:2px 4px;font-size:10px">&#10005;</button></div>
        <div class="favorites" id="favList"></div>
      </div>
      <div class="sidebar-header">Explorer<div class="actions">
        <button class="btn icon" onclick="promptNewFile()" title="New File"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <button class="btn icon" onclick="promptNewFolder()" title="New Folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></button>
        <button class="btn icon" onclick="promptCreateSymlink()" title="New Symlink">&#128279;</button>
        <button class="btn icon" onclick="openBrowserTab('')" title="Browse Root">&#127760;</button>
        <button class="btn icon" onclick="loadSidebar()" title="Refresh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg></button>
      </div></div>
      <div class="sidebar-search"><input type="text" id="sidebarSearch" placeholder="Filter files..."></div>
      <div class="tree" id="fileTree"></div>
      <div class="trash-dock" id="trashDock" onclick="openTrashTab()" title="Open Trash"
           ondragover="trashDockDragOver(event)" ondragleave="trashDockDragLeave(event)" ondrop="trashDockDrop(event)">
        <span class="trash-icon" id="trashDockIcon">&#128465;</span>
        <span class="trash-label">Trash</span>
        <span class="trash-size" id="trashDockSize">Empty</span>
        <span class="trash-count" id="trashDockCount" style="display:none">0</span>
      </div>
    </div>
    <div class="content-area">
      <div class="tab-bar-wrap">
        <div class="tab-bar" id="tabBar"></div>
        <button class="tab-new-btn" id="tabNewBtn" onclick="newTabAtRoot()" title="New tab (opens root, then type a path)">+</button>
      </div>
      <div class="editor-view" id="editorView" style="display:none">
        <div class="find-bar" id="findBar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <input type="text" id="findInput" placeholder="Find...">
          <input type="text" id="replaceInput" placeholder="Replace...">
          <button class="btn" onclick="doFind()">Next</button>
          <button class="btn" onclick="doReplace()">Replace</button>
          <button class="btn" onclick="doReplaceAll()">All</button>
          <button class="btn" id="caseSensitiveBtn" onclick="toggleCaseSensitive()" title="Match Case">Aa</button>
          <label class="auto-find-toggle" title="Auto-navigate to first match"><input type="checkbox" id="autoFindCheckbox" checked>Auto</label>
          <span class="find-info" id="findInfo"></span>
          <span class="close-find" onclick="closeFindBar()">&#10005;</span>
        </div>
        <div class="editor-wrap">
          <div class="editor-cm" id="editorCm"></div>
          <div class="minimap" id="minimap" style="display:none">
            <canvas id="minimapCanvas"></canvas>
            <div class="viewport" id="minimapViewport"></div>
          </div>
        </div>
      </div>
      <div class="browser-view" id="browserView" style="display:none">
        <div class="browser-toolbar">
          <button class="btn icon" onclick="browserGoUp()" title="Up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
          <button class="btn icon" onclick="browserRefresh()" title="Refresh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg></button>
          <div class="browser-breadcrumb" id="browserBreadcrumb"></div>
          <div class="separator"></div>
          <button class="btn" id="btnNewFileB" onclick="promptNewFileInBrowser()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>New</button>
          <button class="btn" id="btnNewFolderB" onclick="promptNewFolderInBrowser()">&#128193; Folder</button>
          <button class="btn" id="btnSymlinkB" onclick="promptCreateSymlinkInBrowser()">&#128279; Symlink</button>
          <button class="btn" id="btnUploadB" onclick="document.getElementById('fileUploadInput').click()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Upload</button>
          <button class="btn" id="btnPasteB" onclick="pasteFiles()" disabled title="Paste (Ctrl+V)">&#128203; Paste</button>
          <div class="separator"></div>
          <button class="btn icon" id="btnDeleteB" onclick="browserDeleteSelected()" disabled title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
          <div class="separator"></div>
          <div class="btn-group">
            <button class="btn icon active" id="btnListView" onclick="setBrowserView('list')" title="List"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>
            <button class="btn icon" id="btnGridView" onclick="setBrowserView('grid')" title="Grid"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg></button>
          </div>
          <div class="separator"></div>
          <div class="browser-search">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <input type="text" id="browserSearchInput" placeholder="Search...">
          </div>
        </div>
        <div class="action-bar" id="actionBar">
          <span class="action-count" id="actionCount"></span>
          <button class="btn" onclick="browserOpenAllSelected()">&#9998; Open All</button>
          <button class="btn" onclick="copySelected()">&#128203; Copy</button>
          <button class="btn" onclick="cutSelected()">&#9986; Cut</button>
          <button class="btn" onclick="browserCopyAllContents()">&#128196; Copy Contents</button>
          <button class="btn" onclick="browserDownloadSelected()">&#11015; Download</button>
          <button class="btn" onclick="browserDeleteSelected()">&#128465; Delete</button>
          <span style="margin-left:auto"></span>
          <button class="btn" onclick="browserClearSelection()">&#10005; Clear</button>
        </div>
        <div class="browser-filelist" id="fileList"></div>
      </div>
      <div class="trash-view" id="trashView" style="display:none">
        <div class="trash-toolbar">
          <h3>&#128465; Trash <span class="trash-total-badge" id="trashTotalBadge">0 items</span></h3>
          <span style="flex:1"></span>
          <div class="trash-search">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <input type="text" id="trashSearchInput" placeholder="Search trash...">
          </div>
          <button class="btn" onclick="trashSelectAll()" title="Select all">&#9744; Select All</button>
          <button class="btn" id="trashRestoreSelBtn" onclick="trashRestoreSelected()" disabled>&#8634; Restore Selected</button>
          <button class="btn danger" id="trashDeleteSelBtn" onclick="trashDeleteSelected()" disabled>&#10005; Delete Selected</button>
          <div class="separator"></div>
          <button class="btn danger" onclick="trashEmptyAll()">&#128465; Empty Trash</button>
        </div>
        <div class="trash-stats-bar" id="trashStatsBar">
          <span class="ts-item"><span>Items:</span> <span class="ts-value" id="tsCount">0</span></span>
          <span class="ts-sep"></span>
          <span class="ts-item"><span>Total size:</span> <span class="ts-value" id="tsTotalSize">0 B</span></span>
        </div>
        <div class="trash-action-bar" id="trashActionBar">
          <span class="ta-count" id="trashSelCount">0 selected</span>
          <button class="btn" style="font-size:10px" onclick="trashRestoreSelected()">&#8634; Restore</button>
          <button class="btn danger" style="font-size:10px" onclick="trashDeleteSelected()">&#10005; Delete Forever</button>
          <span style="flex:1"></span>
          <button class="btn" style="font-size:10px" onclick="trashClearSelection()">Clear Selection</button>
        </div>
        <div class="trash-list" id="trashList"></div>
      </div>
      <div class="welcome" id="welcomeScreen">
        <h2>Welcome to IDE Workspace</h2>
        <p style="color:var(--text3)">Open a file or folder from the sidebar, or use shortcuts</p>
        <div class="shortcuts">
          <span class="key">Click file</span><span class="desc">Open in editor</span>
          <span class="key">Dbl-click folder</span><span class="desc">Browse folder</span>
          <span class="key">Ctrl+S / Ctrl+U</span><span class="desc">Save</span>
          <span class="key">Ctrl+P</span><span class="desc">Command palette</span>
          <span class="key">Ctrl+L</span><span class="desc">Focus path bar</span>
          <span class="key">Ctrl+F / Ctrl+H</span><span class="desc">Find &amp; Replace</span>
          <span class="key">Ctrl+G</span><span class="desc">Go to line</span>
          <span class="key">Ctrl+Shift+L</span><span class="desc">Lint / Check Errors</span>
          <span class="key">Ctrl+/</span><span class="desc">Toggle comment</span>
          <span class="key">Alt+&#8593;/&#8595;</span><span class="desc">Move line</span>
          <span class="key">Ctrl+Shift+D</span><span class="desc">Duplicate line</span>
          <span class="key">Ctrl+C / Ctrl+X</span><span class="desc">Copy / Cut selected files</span>
          <span class="key">Ctrl+V</span><span class="desc">Paste files</span>
          <span class="key">Ctrl+Tab</span><span class="desc">Next tab</span>
          <span class="key">Ctrl+Shift+Tab</span><span class="desc">Previous tab</span>
          <span class="key">Ctrl+W</span><span class="desc">Close tab</span>
        </div>
      </div>
      <div class="problems-resize" id="problemsResize"></div>
      <div class="problems-panel" id="problemsPanel" style="height:160px">
        <div class="problems-header" onclick="toggleProblemsPanel()">
          <span class="problems-title">Problems <span class="cnt ok" id="probCnt">0</span></span>
          <span class="problems-actions">
            <button class="btn icon" data-f="all" onclick="event.stopPropagation();setProbFilter('all')" style="font-size:10px;padding:2px 6px" title="All">All</button>
            <button class="btn icon" data-f="e" onclick="event.stopPropagation();setProbFilter('e')" style="font-size:10px;padding:2px 6px;color:var(--red)" title="Errors">&#10005;</button>
            <button class="btn icon" data-f="w" onclick="event.stopPropagation();setProbFilter('w')" style="font-size:10px;padding:2px 6px;color:var(--yellow)" title="Warnings">&#9888;</button>
            <button class="btn icon" onclick="event.stopPropagation();clearAllProblems()" title="Clear">&#128465;</button>
            <span class="problems-toggle" id="probToggle">&#9660;</span>
          </span>
        </div>
        <div class="problems-list" id="probList"></div>
      </div>
    </div>
    <div class="info-panel" id="infoPanel"></div>
  </div>
  <div class="statusbar">
    <span id="statusMode">Ready</span><span class="sep"></span>
    <span id="statusLang">&mdash;</span><span class="sep"></span>
    <span id="statusCursor">&mdash;</span><span class="sep"></span>
    <span id="statusEncoding">UTF-8</span><span class="sep"></span>
    <span id="statusIndent">Spaces: 4</span>
    <span style="margin-left:auto"><span id="statusLint" style="cursor:pointer" onclick="toggleProblemsPanel()"></span><span class="sep" style="display:inline-block;vertical-align:middle"></span></span>
    <span id="statusFile"></span>
  </div>
</div>
<div class="drop-overlay" id="dropOverlay"><div class="drop-box">&#128194; Drop files here to upload</div></div>
<div class="toast-container" id="toasts"></div>
<div class="task-tray" id="taskTray" aria-live="polite"></div>
<input type="file" id="fileUploadInput" multiple style="display:none">
<div id="lintTip" class="lint-tooltip" style="display:none"></div>
<script>
const API='api.php', WEB_ROOT='https://app.1m8.ai/';
const tabs=[]; let activeTab=null, editor=null;
let treeExpanded=new Set(['']), sidebarCache={}, sidebarFilter='';
let minimapDirty=true, minimapRAF=null;
let findCaseSensitive=false, findAutoRun=true, findOverlay=null, findMatches=[], findCurrentIdx=-1;
let favorites=JSON.parse(localStorage.getItem('ide_favorites')||'[]');
// clipboard: { paths:[], mode:'copy'|'cut' }
let clipboard={paths:[],mode:null};
let infoPanelVisible=false, browserDraggedPaths=[], tabIdCounter=0;
let allProblems={}, probFilter='all', lintDebounceTimer=null, probCollapsed=false;
let tabDragIdx=-1;
let trashCount=0, trashSizeH='';
let taskIdCounter=0, longTasks=[];

// --- HELPERS ---
async function api(p,o={}){
    try{
        let r;
        if(o.upload)r=await fetch(API+'?action=upload&path='+encodeURIComponent(p.path),{method:'POST',body:p.formData});
        else r=await fetch(API+'?'+new URLSearchParams(p));
        if(r.status===413)return{ok:false,error:'File too large.'};
        const text=await r.text();
        let data;
        try{data=JSON.parse(text)}catch(e){data={ok:false,error:r.ok?'Invalid server response.':(text||('HTTP '+r.status))}}
        if(!r.ok&&data.ok!==false)data.ok=false;
        if(!r.ok&&!data.error)data.error='HTTP '+r.status;
        return data;
    }catch(e){return{ok:false,error:'Network: '+e.message}}
}
async function apiPost(path,content){
    try{
        const fd=new FormData();fd.append('content',content);
        const r=await fetch(API+'?action=write&path='+encodeURIComponent(path),{method:'POST',body:fd});
        const text=await r.text();
        let data;
        try{data=JSON.parse(text)}catch(e){data={ok:false,error:text||('HTTP '+r.status)}}
        if(!r.ok&&data.ok!==false)data.ok=false;
        if(!r.ok&&!data.error)data.error='HTTP '+r.status;
        return data;
    }catch(e){return{ok:false,error:'Network: '+e.message}}
}
async function trashApi(p){try{const r=await fetch(API+'?'+new URLSearchParams(p));const text=await r.text();try{return JSON.parse(text)}catch(e){return{ok:false,error:'Invalid response'}}}catch(e){return{ok:false,error:'Network: '+e.message}}}
function toast(m,t='info'){const e=document.createElement('div');e.className='toast '+t;e.textContent=m;document.getElementById('toasts').appendChild(e);setTimeout(()=>{e.style.opacity='0';e.style.transition='opacity .3s';setTimeout(()=>e.remove(),300)},2500)}
function createTask(title,subtitle,detail){
    const id='task_'+(++taskIdCounter);
    longTasks.unshift({id,title,subtitle,detail:detail||'',state:'running',result:'',meta:'',minimized:false,createdAt:Date.now()});
    renderTaskTray();
    return id;
}
function updateTask(id,patch){
    const t=longTasks.find(x=>x.id===id);if(!t)return;
    Object.assign(t,patch);
    renderTaskTray();
}
function dismissTask(id){longTasks=longTasks.filter(t=>t.id!==id);renderTaskTray()}
function toggleTaskMinimized(id){const t=longTasks.find(x=>x.id===id);if(t){t.minimized=!t.minimized;renderTaskTray()}}
function taskStateIcon(t){
    if(t.state==='running')return'<span class="task-spinner"></span>';
    if(t.state==='success')return'\u2713';
    if(t.state==='error')return'\u26A0';
    return'\u2022';
}
function renderTaskTray(){
    const tray=document.getElementById('taskTray');if(!tray)return;
    tray.innerHTML=longTasks.map(t=>{
        const canClose=t.state!=='running';
        return '<div class="task-card '+escH(t.state)+(t.minimized?' minimized':'')+'">'+
            '<div class="task-head"><div class="task-icon">'+taskStateIcon(t)+'</div>'+
            '<div class="task-title"><strong>'+escH(t.title)+'</strong><span>'+escH(t.subtitle||'')+'</span></div>'+
            '<div class="task-actions"><button class="task-btn" data-task-action="toggle" data-task-id="'+escA(t.id)+'" title="'+(t.minimized?'Expand':'Minimize')+'">'+(t.minimized?'+':'-')+'</button>'+
            (canClose?'<button class="task-btn" data-task-action="dismiss" data-task-id="'+escA(t.id)+'" title="Dismiss">\u2715</button>':'')+'</div></div>'+
            '<div class="task-body">'+(t.detail?'<div>'+escH(t.detail)+'</div>':'')+(t.result?'<div class="task-result">'+escH(t.result)+'</div>':'')+(t.meta?'<div class="task-meta">'+escH(t.meta)+'</div>':'')+'</div></div>';
    }).join('');
}
document.addEventListener('click',e=>{
    const btn=e.target.closest('[data-task-action]');if(!btn)return;
    const id=btn.getAttribute('data-task-id'), action=btn.getAttribute('data-task-action');
    if(action==='toggle')toggleTaskMinimized(id);
    if(action==='dismiss')dismissTask(id);
});
function escH(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function escA(s){return(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;')}
function esc(s){return String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}
function fileIcon(name,isDir){if(isDir)return'\u{1F4C1}';const ext=(typeof name==='object'?(name.ext||(name.name||'').split('.').pop()):(name||'').split('.').pop()||'').toLowerCase();const m={php:'\u{1F418}',js:'\u{1F7E8}',jsx:'\u269B\uFE0F',ts:'\u{1F537}',tsx:'\u269B\uFE0F',json:'\u{1F4CB}',html:'\u{1F310}',htm:'\u{1F310}',css:'\u{1F3A8}',py:'\u{1F40D}',rb:'\u{1F48E}',go:'\u{1F535}',rs:'\u{1F980}',java:'\u2615',c:'\u00A9\uFE0F',cpp:'\u00A9\uFE0F',md:'\u{1F4DD}',txt:'\u{1F4C4}',log:'\u{1F4C3}',sh:'\u{1F5A5}\uFE0F',sql:'\u{1F5C3}\uFE0F',yaml:'\u2699\uFE0F',yml:'\u2699\uFE0F',xml:'\u{1F4F0}',svg:'\u{1F5BC}\uFE0F',png:'\u{1F5BC}\uFE0F',jpg:'\u{1F5BC}\uFE0F',jpeg:'\u{1F5BC}\uFE0F',gif:'\u{1F5BC}\uFE0F',webp:'\u{1F5BC}\uFE0F',mp4:'\u{1F3AC}',webm:'\u{1F3AC}',mp3:'\u{1F3B5}',pdf:'\u{1F4D5}',zip:'\u{1F4E6}',gz:'\u{1F4E6}'};return m[ext]||'\u{1F4C4}'}
function detectMode(path){const ext=(path.split('.').pop()||'').toLowerCase();const m={php:'application/x-httpd-php',js:'javascript',jsx:'javascript',mjs:'javascript',ts:'javascript',tsx:'javascript',json:{name:'javascript',json:true},html:'htmlmixed',htm:'htmlmixed',css:'css',scss:'css',py:'python',rb:'ruby',go:'go',rs:'rust',java:'text/x-java',c:'text/x-csrc',cpp:'text/x-c++src',h:'text/x-csrc',sql:'sql',md:'markdown',xml:'xml',svg:'xml',yaml:'yaml',yml:'yaml',toml:'toml',sh:'shell',bash:'shell',dockerfile:'dockerfile',conf:'nginx',ini:'properties',env:'properties'};return m[ext]||'text/plain'}
function modeName(mode){if(typeof mode==='object')return mode.name||'Plain Text';const n={'application/x-httpd-php':'PHP','javascript':'JavaScript','htmlmixed':'HTML','css':'CSS','python':'Python','ruby':'Ruby','go':'Go','rust':'Rust','sql':'SQL','markdown':'Markdown','xml':'XML','yaml':'YAML','toml':'TOML','shell':'Shell','dockerfile':'Dockerfile','text/x-java':'Java','text/x-csrc':'C','text/x-c++src':'C++','text/plain':'Plain Text'};return n[mode]||mode}
function getPreviewType(name){const ext=(name||'').split('.').pop().toLowerCase();if(['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext))return'image';if(['mp4','webm','mov','ogg'].includes(ext))return'video';if(ext==='pdf')return'pdf';return null}
function isArchive(name){const ext=(name||'').split('.').pop().toLowerCase();return['zip','gz','tgz','tar','bz2','xz'].includes(ext)}
function isImage(name){const ext=(name||'').split('.').pop().toLowerCase();return['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext)}
function thumbUrl(path){return API+'?action=download&path='+encodeURIComponent(path)}
function fileIconHtml(name,isDir,path){if(!isDir&&path&&isImage(name))return'<img class="thumb" src="'+thumbUrl(path)+'" loading="lazy" onerror="this.replaceWith(document.createTextNode(\'\u{1F5BC}\uFE0F\'))">';return'<span style="font-size:15px">'+fileIcon(name,isDir)+'</span>'}
function fileIconGrid(name,isDir,path){if(!isDir&&path&&isImage(name))return'<img class="thumb-lg" src="'+thumbUrl(path)+'" loading="lazy" onerror="this.style.display=\'none\';this.insertAdjacentText(\'afterend\',\'\u{1F5BC}\uFE0F\')">';return fileIcon(name,isDir)}
function fileIconTree(name,isDir,path){if(!isDir&&path&&isImage(name))return'<img class="thumb-sm" src="'+thumbUrl(path)+'" loading="lazy" onerror="this.replaceWith(document.createTextNode(\'\u{1F5BC}\uFE0F\'))">';return fileIcon(name,isDir)}
function fileIconTab(name,isDir,path){if(!isDir&&path&&isImage(name))return'<img class="thumb-tab" src="'+thumbUrl(path)+'" loading="lazy" onerror="this.replaceWith(document.createTextNode(\'\u{1F5BC}\uFE0F\'))">';return fileIcon(name,isDir)}
function getFileExt(p){return(p||'').split('.').pop().toLowerCase()}

// --- CLIPBOARD ---
function copySelected(){
    if(!activeTab||activeTab.type!=='browser'||!activeTab.selected.size)return;
    clipboard={paths:[...activeTab.selected],mode:'copy'};
    toast(clipboard.paths.length+' item(s) copied — Ctrl+V to paste','info');
    updateClipboardUI();renderBrowserTab();
}
function cutSelected(){
    if(!activeTab||activeTab.type!=='browser'||!activeTab.selected.size)return;
    clipboard={paths:[...activeTab.selected],mode:'cut'};
    toast(clipboard.paths.length+' item(s) cut — Ctrl+V to paste','info');
    updateClipboardUI();renderBrowserTab();
}
function clearClipboard(){
    clipboard={paths:[],mode:null};updateClipboardUI();renderBrowserTab();
}
function updateClipboardUI(){
    const ind=document.getElementById('clipboardIndicator');
    const paste=document.getElementById('btnPasteB');
    if(!clipboard.paths.length){ind.className='clipboard-indicator';ind.textContent='';if(paste)paste.disabled=true;return}
    const icon=clipboard.mode==='cut'?'✂️':'📋';
    ind.textContent=icon+' '+clipboard.paths.length+' item(s) '+(clipboard.mode==='cut'?'cut':'copied')+' — click to clear';
    ind.className='clipboard-indicator visible'+(clipboard.mode==='cut'?' cut-mode':'');
    if(paste)paste.disabled=false;
}
async function pasteFiles(destDir){
    if(!clipboard.paths.length)return;
    const dest=destDir!==undefined?destDir:(activeTab&&activeTab.type==='browser'?activeTab.path:'');
    let ok=0,fail=0;
    const actionLabel=clipboard.mode==='cut'?'Move':'Copy';
    const progressVerb=clipboard.mode==='cut'?'Moving':'Copying';
    const taskId=createTask(actionLabel+' files',clipboard.paths.length+' item'+(clipboard.paths.length===1?'':'s'),'Pasting into '+(dest?'/'+dest:'/'));
    for(const src of clipboard.paths){
        const name=src.split('/').pop();
        const dst=(dest?dest+'/':'')+name;
        if(src===dst)continue;
        const action=clipboard.mode==='cut'?'move':'copy';
        updateTask(taskId,{detail:progressVerb+' '+name});
        const r=await api({action,src,dst});
        if(r.ok!==false)ok++;else{fail++;toast('Failed to paste '+name+': '+(r.error||''),'error')}
    }
    if(clipboard.mode==='cut'&&ok>0)clipboard={paths:[],mode:null};
    updateClipboardUI();
    updateTask(taskId,{state:fail?'error':'success',detail:'Paste finished',result:ok+' completed'+(fail?', '+fail+' failed':''),meta:'Destination '+(dest?'/'+dest:'/')});
    if(ok)toast(ok+' item(s) pasted','success');
    if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab);
    loadSidebar();renderBrowserTab();
}

// --- SYMLINK HELPERS ---
function isSymlink(item){return !!(item && item.isSymlink)}
function isSymlinkBroken(item){return !!(item && item.isSymlink && item.symlinkBroken)}
function symlinkTarget(item){return (item && item.symlinkTarget) || ''}
function dirIconHtml(item){
    if(!item||!item.isDir) return fileIcon(item?item.name:'',false);
    if(isSymlink(item)){
        if(isSymlinkBroken(item)) return '\u{1F4C1}\u26D4';
        return '\u{1F4C1}\u{1F517}';
    }
    return '\u{1F4C1}';
}

// --- SYMLINK API ACTIONS ---
async function apiCreateSymlink(linkPath, targetPath){return api({action:'create_symlink', path:linkPath, target:targetPath})}
async function apiEditSymlink(linkPath, newTarget){return api({action:'edit_symlink', path:linkPath, target:newTarget})}
async function apiSymlinkInfo(linkPath){return api({action:'symlink_info', path:linkPath})}
async function apiRemoveSymlink(linkPath){return api({action:'remove_symlink', path:linkPath})}

// --- SYMLINK UI FUNCTIONS ---
function promptCreateSymlink(){
    let dir='';
    if(activeTab) dir=activeTab.type==='browser'?activeTab.path:(activeTab.path?activeTab.path.substring(0,activeTab.path.lastIndexOf('/')):'');
    showSymlinkModal('Create Symlink', dir, '', '', async (linkName, target)=>{
        if(!linkName || !target) return;
        const linkPath = (dir ? dir+'/' : '') + linkName;
        const r = await apiCreateSymlink(linkPath, target);
        if(r.ok){toast('Symlink created: '+linkName,'success'); loadSidebar(); if(activeTab&&activeTab.type==='browser') await browserLoadDir(activeTab)}
        else toast('Failed: '+(r.error||'Unknown error'),'error');
    });
}
function promptCreateSymlinkInBrowser(){
    const dir = activeTab && activeTab.type==='browser' ? activeTab.path : '';
    showSymlinkModal('Create Symlink', dir, '', '', async (linkName, target)=>{
        if(!linkName || !target) return;
        const linkPath = (dir ? dir+'/' : '') + linkName;
        const r = await apiCreateSymlink(linkPath, target);
        if(r.ok){toast('Symlink created: '+linkName,'success'); if(activeTab&&activeTab.type==='browser') await browserLoadDir(activeTab); loadSidebar()}
        else toast('Failed: '+(r.error||'Unknown error'),'error');
    });
}
function promptEditSymlink(item){
    showSymlinkEditModal(item, async (newTarget)=>{
        if(!newTarget) return;
        const r = await apiEditSymlink(item.path, newTarget);
        if(r.ok){toast('Symlink updated','success'); if(activeTab&&activeTab.type==='browser') await browserLoadDir(activeTab); loadSidebar()}
        else toast('Failed: '+(r.error||'Unknown error'),'error');
    });
}
async function promptRemoveSymlink(item){
    if(!confirm('Remove symlink "'+item.name+'"?\n(This removes the link only, not the target.)')) return;
    const r = await apiRemoveSymlink(item.path);
    if(r.ok){toast('Symlink removed','success'); if(activeTab&&activeTab.type==='browser'){activeTab.selected.delete(item.path); await browserLoadDir(activeTab)} loadSidebar()}
    else toast('Failed: '+(r.error||'Unknown error'),'error');
}
async function showSymlinkInfoModal(item){
    const r = await apiSymlinkInfo(item.path);closeModal();
    let bodyH = '<div class="symlink-info-box">';
    bodyH += '<div class="si-label">Link Path</div><div class="si-value">/'+escH(item.path)+'</div>';
    if(r.ok){bodyH += '<div class="si-label" style="margin-top:8px">Target</div><div class="si-value">'+escH(r.target||symlinkTarget(item)||'unknown')+'</div>';
        if(r.resolvedPath) bodyH += '<div class="si-label" style="margin-top:8px">Resolved Path</div><div class="si-value">'+escH(r.resolvedPath)+'</div>';
        bodyH += '<div class="si-status '+(r.broken?'broken':'valid')+'">'+(r.broken?'\u2717 Broken':'\u2713 Valid')+'</div>';
    } else {bodyH += '<div class="si-label" style="margin-top:8px">Target</div><div class="si-value">'+escH(symlinkTarget(item)||'unknown')+'</div>';bodyH += '<div class="si-status broken">\u26A0 Could not resolve</div>'}
    bodyH += '</div>';
    document.body.insertAdjacentHTML('beforeend','<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this)closeModal()"><div class="modal"><div class="modal-header"><h3>\u{1F517} Symlink Info</h3><button class="btn icon" onclick="closeModal()">\u2715</button></div><div class="modal-body">'+bodyH+'</div><div class="modal-footer"><button class="btn" onclick="closeModal()">Close</button><button class="btn primary" onclick="closeModal();promptEditSymlink('+escA(JSON.stringify({path:item.path,name:item.name,isSymlink:true,symlinkTarget:r.ok?r.target:symlinkTarget(item)}))+')">Edit Target</button></div></div></div>');
}
function showSymlinkModal(title, dir, defaultName, defaultTarget, onOk){
    closeModal();
    document.body.insertAdjacentHTML('beforeend','<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this)closeModal()"><div class="modal"><div class="modal-header"><h3>\u{1F517} '+escH(title)+'</h3><button class="btn icon" onclick="closeModal()">\u2715</button></div><div class="modal-body"><div class="symlink-field-group"><div><label>Link name</label><input type="text" id="symlinkNameInput" value="'+escA(defaultName)+'" placeholder="my-link"></div><div><label>Target path</label><input type="text" id="symlinkTargetInput" value="'+escA(defaultTarget)+'" placeholder="/var/www/target"></div>'+(dir?'<div style="font-size:11px;color:var(--text3)">In: /'+escH(dir)+'</div>':'')+'</div></div><div class="modal-footer"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" id="symlinkOkBtn">\u{1F517} Create Symlink</button></div></div></div>');
    const nameInp=document.getElementById('symlinkNameInput'),targetInp=document.getElementById('symlinkTargetInput');nameInp.focus();
    const ok=()=>{const n=nameInp.value.trim(),t=targetInp.value.trim();closeModal();onOk(n,t)};
    document.getElementById('symlinkOkBtn').addEventListener('click',ok);
    nameInp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();targetInp.focus()}if(e.key==='Escape')closeModal()});
    targetInp.addEventListener('keydown',e=>{if(e.key==='Enter')ok();if(e.key==='Escape')closeModal()});
}
function showSymlinkEditModal(item, onOk){
    closeModal();const currentTarget = symlinkTarget(item) || '';
    document.body.insertAdjacentHTML('beforeend','<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this)closeModal()"><div class="modal"><div class="modal-header"><h3>\u270F\uFE0F Edit Symlink</h3><button class="btn icon" onclick="closeModal()">\u2715</button></div><div class="modal-body"><div style="font-size:12px;color:var(--text2);margin-bottom:12px">Editing: <span style="color:var(--symlink);font-family:var(--mono)">'+escH(item.name)+'</span></div><label>New target</label><input type="text" id="symlinkEditTarget" value="'+escA(currentTarget)+'"></div><div class="modal-footer"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" id="symlinkEditOkBtn">\u2714 Update</button></div></div></div>');
    const inp=document.getElementById('symlinkEditTarget');inp.focus();inp.select();
    const ok=()=>{const t=inp.value.trim();closeModal();onOk(t)};
    document.getElementById('symlinkEditOkBtn').addEventListener('click',ok);
    inp.addEventListener('keydown',e=>{if(e.key==='Enter')ok();if(e.key==='Escape')closeModal()});
}

// --- SIDEBAR ---
async function loadSidebar(){sidebarCache={};await ensureSidebarLoaded('');for(const p of treeExpanded){if(p)await ensureSidebarLoaded(p)}renderSidebarTree()}
async function ensureSidebarLoaded(path){if(sidebarCache[path])return;const r=await api({action:'list',path});if(!r.ok)return;sidebarCache[path]=r.items.sort((a,b)=>{if(a.isDir!==b.isDir)return a.isDir?-1:1;return a.name.localeCompare(b.name,undefined,{sensitivity:'base'})})}
function renderSidebarTree(){document.getElementById('fileTree').innerHTML=buildSidebarHtml(sidebarCache['']||[],0)}
function buildSidebarHtml(nodes,depth){
    let h='';const filter=sidebarFilter.toLowerCase();
    nodes.forEach(n=>{
        if(filter&&!n.name.toLowerCase().includes(filter)&&!n.isDir)return;
        const isActive=activeTab&&((activeTab.type==='editor'&&activeTab.path===n.path)||(activeTab.type==='browser'&&activeTab.path===n.path));
        const pad=8+depth*14;
        const fp=allProblems[n.path]||[];
        const ec=fp.filter(p=>p.sev==='e').length,wc=fp.filter(p=>p.sev==='w').length;
        let badge='';if(ec)badge='<span class="tree-lint-badge err">'+ec+'</span>';else if(wc)badge='<span class="tree-lint-badge warn">'+wc+'</span>';
        const isSL = isSymlink(n), isBroken = isSymlinkBroken(n);
        const slCls = isSL ? ' is-symlink' : '', brokenCls = isBroken ? ' broken-symlink' : '';
        const slArrow = isSL ? '<span class="symlink-arrow" title="Symlink \u2192 '+escA(symlinkTarget(n))+'">\u{1F517}</span>' : '';
        if(n.isDir){const exp=treeExpanded.has(n.path);
            h+='<div class="tree-item'+(isActive?' active':'')+slCls+brokenCls+'" style="padding-left:'+pad+'px" onclick="toggleDir(\''+esc(n.path)+'\')" ondblclick="event.stopPropagation();openBrowserTab(\''+esc(n.path)+'\')" oncontextmenu="event.preventDefault();event.stopPropagation();showTreeContextMenu(event,'+escA(JSON.stringify(n))+')" draggable="true" ondragstart="treeDragStart(event,\''+esc(n.path)+'\')" ondragover="treeDragOver(event,\''+esc(n.path)+'\')" ondragleave="treeDragLeave(event)" ondrop="treeDrop(event,\''+esc(n.path)+'\')">';
            h+='<span class="arrow '+(exp?'open':'')+'">&#9654;</span><span class="icon">\u{1F4C1}'+(isSL?'<span class="sl-overlay">\u{1F517}</span>':'')+'</span><span class="name">'+escH(n.name)+'</span>'+slArrow+badge+'</div>';
            if(exp&&sidebarCache[n.path])h+=buildSidebarHtml(sidebarCache[n.path],depth+1);
        }else{
            h+='<div class="tree-item'+(isActive?' active':'')+slCls+brokenCls+'" style="padding-left:'+(pad+14)+'px" onclick="openEditorTab(\''+esc(n.path)+'\')" oncontextmenu="event.preventDefault();event.stopPropagation();showTreeContextMenu(event,'+escA(JSON.stringify(n))+')" draggable="true" ondragstart="treeDragStart(event,\''+esc(n.path)+'\')">';
            h+='<span class="icon">'+fileIconTree(n.name,false,n.path)+'</span><span class="name">'+escH(n.name)+'</span>'+slArrow+badge+'</div>';
        }
    });return h;
}
function treeDragStart(e,path){browserDraggedPaths=[path];e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',JSON.stringify([path]))}
function treeDragOver(e,path){if(browserDraggedPaths.includes(path))return;e.preventDefault();e.currentTarget.classList.add('drag-target')}
function treeDragLeave(e){e.currentTarget.classList.remove('drag-target')}
async function treeDrop(e,targetDir){
    e.preventDefault();e.currentTarget.classList.remove('drag-target');
    if(!browserDraggedPaths.length)return;
    for(const p of browserDraggedPaths){
        const name=p.split('/').pop();const newPath=(targetDir?targetDir+'/':'')+name;
        if(newPath===p||p===targetDir)continue;
        if(targetDir.startsWith(p+'/'))continue;
        await api({action:'rename',path:p,newPath});
    }
    browserDraggedPaths=[];loadSidebar();if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab);
}
function showTreeContextMenu(e, item){
    closeContextMenu();
    const isSL = isSymlink(item);
    let h='<div class="context-menu" id="ctxMenu" style="left:'+e.clientX+'px;top:'+e.clientY+'px">';
    if(item.isDir){
        h+=cmi('\u{1F4C2}','Open in Tab','',()=>browserNavigate(item.path));
        h+=cmi('\u{1F4D1}','Open in New Tab','',()=>openBrowserTab(item.path));
        h+=cmi('\u{1F4CF}','Calculate Folder Size','',()=>calculateDirectorySize(item));
        h+=cmi('\u{1F4E5}','Download as Zip','',()=>downloadAsZip(item.path));
    } else {
        h+=cmi('\u270F\uFE0F','Edit','',()=>openEditorTab(item.path));
        if(isArchive(item.name))h+=cmi('\u{1F4E6}','Extract Here','',()=>extractArchive(item.path));
    }
    h+='<div class="menu-divider"></div>';
    // Copy / Cut from tree
    h+=cmi('\u{1F4CB}','Copy','Ctrl+C',()=>{clipboard={paths:[item.path],mode:'copy'};toast('Copied: '+item.name,'info');updateClipboardUI()});
    h+=cmi('\u2702\uFE0F','Cut','Ctrl+X',()=>{clipboard={paths:[item.path],mode:'cut'};toast('Cut: '+item.name,'info');updateClipboardUI();renderBrowserTab()});
    h+='<div class="menu-divider"></div>';
    if(isSL){
        h+=cmi('\u{1F517}','Symlink Info','',()=>showSymlinkInfoModal(item));
        h+=cmi('\u270F\uFE0F','Edit Symlink Target','',()=>promptEditSymlink(item));
        h+=cmi('\u{1F5D1}\uFE0F','Remove Symlink','',()=>promptRemoveSymlink(item),'','danger');
    } else {
        h+=cmi('\u{1F517}','Create Symlink Here','',()=>{
            const dir = item.isDir ? item.path : item.path.substring(0, item.path.lastIndexOf('/'));
            showSymlinkModal('Create Symlink', dir, '', item.isDir ? '' : item.path, async (linkName, target)=>{
                if(!linkName||!target) return;
                const linkPath = (dir ? dir+'/' : '') + linkName;
                const r = await apiCreateSymlink(linkPath, target);
                if(r.ok){toast('Symlink created','success'); loadSidebar(); if(activeTab&&activeTab.type==='browser') await browserLoadDir(activeTab)}
                else toast('Failed: '+(r.error||'Unknown error'),'error');
            });
        });
    }
    h+=cmi('\u270F\uFE0F','Rename','',()=>startRename(item));
    h+=cmi('\u{1F5D1}\uFE0F','Move to Trash','',()=>moveItemToTrash(item),'','danger');
    h+='</div>';
    document.body.insertAdjacentHTML('beforeend',h);
    const menu=document.getElementById('ctxMenu'),r2=menu.getBoundingClientRect();
    if(r2.right>innerWidth)menu.style.left=(e.clientX-r2.width)+'px';if(r2.bottom>innerHeight)menu.style.top=(e.clientY-r2.height)+'px';
}
async function toggleDir(p){if(treeExpanded.has(p))treeExpanded.delete(p);else{treeExpanded.add(p);await ensureSidebarLoaded(p)}renderSidebarTree()}
document.getElementById('sidebarSearch').addEventListener('input',e=>{sidebarFilter=e.target.value.trim();renderSidebarTree()});

// --- TABS ---
function renderTabs(){
    document.getElementById('tabBar').innerHTML=tabs.map((t,i)=>{
        let name=t.path?t.path.split('/').pop():(t.type==='browser'?'Root':'Untitled');
        let icon, typeLabel='', cls='tab '+(activeTab===t?'active':'')+' '+(t.modified?'modified':'');
        if(t.type==='trash'){
            name='Trash';icon='\u{1F5D1}\uFE0F';typeLabel='TRASH';
            cls+=' ';
        } else {
            icon=t.type==='browser'?'\u{1F4C2}':fileIconTab(name,false,t.path);
            typeLabel=t.type==='browser'?'DIR':'';
            const probs=t.type==='editor'?(allProblems[t.path]||[]):[];
            const hasE=probs.some(p=>p.sev==='e'),hasW=probs.some(p=>p.sev==='w');
            let dot='';if(hasE)dot='<span class="tab-err-dot e"></span>';else if(hasW)dot='<span class="tab-err-dot w"></span>';
            if(hasE)cls+=' has-errors';else if(hasW)cls+=' has-warnings';
            if(t.isSymlink)cls+=' is-symlink';
        }
        const slBadge=t.isSymlink?'<span class="symlink-badge" title="Symlink">\u{1F517}</span>':'';
        return'<div class="'+cls+'" draggable="true" onclick="switchTab(tabs['+i+'])" ondragstart="tabDragStart(event,'+i+')" ondragover="tabDragOver(event,'+i+')" ondrop="tabDrop(event,'+i+')" ondragend="tabDragEnd(event)" title="'+escA(t.path||'/')+'">'+
            (typeLabel?'<span class="tab-type">'+typeLabel+'</span>':'')+
            '<span class="tab-icon">'+icon+'</span><span class="tab-title">'+escH(name)+'</span>'+slBadge+
            '<span class="tab-close" onclick="event.stopPropagation();closeTab('+i+')">\u00d7</span></div>';
    }).join('');
}
function tabDragStart(e,idx){tabDragIdx=idx;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/tab-drag',''+idx);e.target.classList.add('dragging')}
function tabDragOver(e,idx){if(tabDragIdx<0||tabDragIdx===idx)return;e.preventDefault();e.dataTransfer.dropEffect='move';document.querySelectorAll('.tab').forEach(t=>t.classList.remove('tab-drop-left','tab-drop-right'));const rect=e.currentTarget.getBoundingClientRect();const mid=rect.left+rect.width/2;e.currentTarget.classList.add(e.clientX<mid?'tab-drop-left':'tab-drop-right')}
function tabDrop(e,idx){e.preventDefault();document.querySelectorAll('.tab').forEach(t=>t.classList.remove('tab-drop-left','tab-drop-right','dragging'));if(tabDragIdx<0||tabDragIdx===idx){tabDragIdx=-1;return}const rect=e.currentTarget.getBoundingClientRect();const mid=rect.left+rect.width/2;const dropBefore=e.clientX<mid;const tab=tabs[tabDragIdx];tabs.splice(tabDragIdx,1);let newIdx=idx;if(tabDragIdx<idx)newIdx--;if(!dropBefore)newIdx++;tabs.splice(newIdx,0,tab);tabDragIdx=-1;renderTabs();updateUrl()}
function tabDragEnd(e){tabDragIdx=-1;e.target.classList.remove('dragging');document.querySelectorAll('.tab').forEach(t=>t.classList.remove('tab-drop-left','tab-drop-right','dragging'))}

function switchTab(tab){
    if(activeTab===tab&&tab)return;
    if(activeTab&&activeTab.type==='browser')activeTab.scrollTop=document.getElementById('fileList').scrollTop;
    activeTab=tab;renderTabs();
    const edView=document.getElementById('editorView'),brView=document.getElementById('browserView'),welcome=document.getElementById('welcomeScreen'),mm=document.getElementById('minimap'),trView=document.getElementById('trashView');
    if(!tab){edView.style.display='none';brView.style.display='none';trView.style.display='none';welcome.style.display='flex';mm.style.display='none';editor.getWrapperElement().style.display='none';document.getElementById('downloadBtn').style.display='none';updateStatusBar();return}
    welcome.style.display='none';
    if(tab.type==='editor'){
        brView.style.display='none';trView.style.display='none';edView.style.display='flex';editor.getWrapperElement().style.display='';
        editor.swapDoc(tab.doc);editor.setOption('mode',tab.mode);
        mm.style.display='block';editor.focus();editor.refresh();
        minimapDirty=true;setTimeout(()=>{renderMinimap();updateMinimapViewport()},50);
        applyLintDecorations(tab);
        document.getElementById('downloadBtn').style.display='';
    }else if(tab.type==='trash'){
        edView.style.display='none';brView.style.display='none';mm.style.display='none';editor.getWrapperElement().style.display='none';
        trView.style.display='flex';
        loadTrashItems(tab);
        document.getElementById('downloadBtn').style.display='none';
    }else{
        edView.style.display='none';trView.style.display='none';brView.style.display='flex';mm.style.display='none';editor.getWrapperElement().style.display='none';
        renderBrowserTab();setTimeout(()=>{document.getElementById('fileList').scrollTop=tab.scrollTop||0},10);
        document.getElementById('downloadBtn').style.display='none';
    }
    updateStatusBar();renderSidebarTree();updateUrl();updateLintUI();
}
function closeTab(idx){const tab=tabs[idx];if(tab.type==='editor'&&tab.modified&&!confirm('Unsaved changes in '+tab.path.split('/').pop()+'. Close?'))return;tabs.splice(idx,1);if(activeTab===tab){activeTab=null;switchTab(tabs[idx]||tabs[idx-1]||null)}renderTabs();updateUrl()}
function updateUrl(){
    const u=new URL(location);u.searchParams.delete('file');u.searchParams.delete('dir');u.searchParams.delete('tabs');u.searchParams.delete('active');
    if(tabs.length){const encoded=tabs.map(t=>(t.type==='editor'?'e:':(t.type==='trash'?'t:':'b:'))+t.path).join('|');u.searchParams.set('tabs',encoded);
        const ai=tabs.indexOf(activeTab);if(ai>=0)u.searchParams.set('active',''+ai)}
    history.replaceState({},'',u);
    document.title=activeTab?'IDE \u2014 '+(activeTab.type==='trash'?'Trash':activeTab.path?activeTab.path.split('/').pop():'Root'):'IDE \u2014 Workspace';
    updateUrlBar();
}

// --- URL BAR (Windows-Explorer-style path navigator) ---
function updateUrlBar(){
    const inp=document.getElementById('urlBar');
    if(!inp)return;
    // Don't clobber what the user is currently typing
    if(document.activeElement===inp)return;
    const icon=document.getElementById('urlIcon');
    let val='/';
    let iconSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
    if(activeTab){
        if(activeTab.type==='trash'){
            val='trash://';
            iconSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
        }else if(activeTab.type==='editor'){
            val='/'+(activeTab.path||'');
            iconSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
        }else{
            val='/'+(activeTab.path||'');
        }
    }
    inp.value=val;
    if(icon)icon.innerHTML=iconSvg;
}
function urlBarFocus(){
    const inp=document.getElementById('urlBar');
    if(!inp)return;
    inp.focus();inp.select();
}
async function urlBarNavigate(){
    const inp=document.getElementById('urlBar');
    if(!inp)return;
    let raw=(inp.value||'').trim();
    // Trash shortcut
    if(/^trash:?\/?\/?$/i.test(raw)){openTrashTab();inp.blur();return}
    // Normalize: strip protocol-ish prefixes, collapse slashes, trim leading/trailing /
    let path=raw.replace(/^\/+/,'').replace(/\/+$/,'').replace(/\/{2,}/g,'/');
    // Root case
    if(path===''){
        if(activeTab&&activeTab.type==='browser')browserNavigate('');
        else openBrowserTab('');
        inp.blur();return;
    }
    // Try as directory first
    const rDir=await api({action:'list',path});
    if(rDir.ok){
        if(activeTab&&activeTab.type==='browser'){
            browserNavigate(path);
        }else{
            openBrowserTab(path);
        }
        inp.blur();return;
    }
    // Try as file
    const rFile=await api({action:'read',path});
    if(rFile.ok){
        if(activeTab&&activeTab.type==='editor'&&activeTab.path!==path){
            await replaceEditorTabPath(activeTab,path,rFile);
        }else{
            // openEditorTab will re-read; that's fine and reuses tabs if open
            await openEditorTab(path);
        }
        inp.blur();return;
    }
    toast('Path not found: /'+path,'error');
    updateUrlBar();
}
async function replaceEditorTabPath(tab,newPath,readResp){
    if(!tab||tab.type!=='editor')return;
    if(tab.path===newPath)return;
    if(tab.modified){
        if(!confirm('Unsaved changes in '+tab.path.split('/').pop()+'. Discard and open '+newPath.split('/').pop()+'?')){
            updateUrlBar();return;
        }
    }
    // If another editor tab is already open for this path, close current and switch to it
    const existing=tabs.find(t=>t!==tab&&t.type==='editor'&&t.path===newPath);
    if(existing){
        const idx=tabs.indexOf(tab);
        if(idx>=0)tabs.splice(idx,1);
        activeTab=null;
        switchTab(existing);
        return;
    }
    // Replace tab contents in place
    tab.path=newPath;
    tab.mode=detectMode(newPath);
    tab.doc=CodeMirror.Doc(readResp.content||'',tab.mode);
    tab.modified=false;
    tab.isSymlink=readResp.isSymlink||false;
    tab.symlinkTarget=readResp.symlinkTarget||'';
    editor.swapDoc(tab.doc);
    editor.setOption('mode',tab.mode);
    renderTabs();
    updateUrl();
    updateStatusBar();
    applyLintDecorations(tab);
    autoLint(tab);
}
// New-tab button: always create a fresh browser tab at root and focus the URL bar
function newTabAtRoot(){
    const tab={type:'browser',path:'',items:[],selected:new Set(),sortCol:'name',sortAsc:true,view:'list',scrollTop:0,searchFilter:''};
    tabs.push(tab);switchTab(tab);browserLoadDir(tab);
    // Focus the URL bar so the user can immediately type a destination
    setTimeout(()=>{const inp=document.getElementById('urlBar');if(inp){inp.focus();inp.select()}},30);
}

// --- EDITOR ---
async function openEditorTab(path, jumpToLine){
    let existing=tabs.find(t=>t.type==='editor'&&t.path===path);
    if(existing){switchTab(existing);if(jumpToLine!==undefined)editor.setCursor(jumpToLine-1,0);return}
    const r=await api({action:'read',path});if(!r.ok){toast('Cannot open: '+(r.error||'Unknown'),'error');return}
    const mode=detectMode(path);
    const doc=CodeMirror.Doc(r.content||'',mode);
    const tab={type:'editor',path,mode,doc,modified:false,isSymlink:r.isSymlink||false,symlinkTarget:r.symlinkTarget||''};
    tabs.push(tab);switchTab(tab);
    if(jumpToLine!==undefined)setTimeout(()=>editor.setCursor(jumpToLine-1,0),50);
    autoLint(tab);
}
async function saveCurrentFile(){
    if(!activeTab||activeTab.type!=='editor')return;
    const tab=activeTab,content=tab.doc.getValue();
    const r=await apiPost(tab.path,content);
    if(r.ok!==false){tab.modified=false;renderTabs();toast('Saved '+tab.path.split('/').pop(),'success');autoLint(tab)}
    else toast('Save failed: '+(r.error||''),'error');
}
function downloadCurrentFile(){
    if(!activeTab||activeTab.type!=='editor')return;
    const content=editor.getValue();
    const filename=activeTab.path.split('/').pop();
    const blob=new Blob([content],{type:'text/plain'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=filename;a.click();
    URL.revokeObjectURL(url);
    toast('Downloaded: '+filename,'success');
}
function updateStatusBar(){
    const m=document.getElementById('statusMode'),l=document.getElementById('statusLang'),c=document.getElementById('statusCursor'),f=document.getElementById('statusFile');
    if(!activeTab||activeTab.type!=='editor'){m.textContent=activeTab?'Browse':'Ready';l.textContent='\u2014';c.textContent='\u2014';f.textContent=activeTab&&activeTab.path?activeTab.path:'';return}
    m.textContent=activeTab.modified?'Modified':'Saved';
    l.textContent=modeName(activeTab.mode);
    const cur=editor.getCursor();c.textContent='Ln '+(cur.line+1)+', Col '+(cur.ch+1);
    f.textContent=activeTab.path;
}

// --- LINT SYSTEM ---
function autoLint(tab){if(lintDebounceTimer)clearTimeout(lintDebounceTimer);lintDebounceTimer=setTimeout(()=>lintTab(tab),800)}
async function lintTab(tab){
    if(!tab||tab.type!=='editor')return;
    const ext=getFileExt(tab.path);
    if(!['php','js','jsx','ts','tsx','json','css','py','html','htm'].includes(ext))return;
    const r=await api({action:'lint',path:tab.path});
    if(r.ok!==false&&r.problems){allProblems[tab.path]=r.problems;if(activeTab===tab)applyLintDecorations(tab);updateLintUI();renderTabs();renderSidebarTree()}
}
async function lintCurrentFile(){if(activeTab&&activeTab.type==='editor')await lintTab(activeTab)}
function applyLintDecorations(tab){
    if(!tab||tab.type!=='editor')return;
    editor.clearGutter('lint-gutter');
    const probs=allProblems[tab.path]||[];
    const lineClasses={};
    probs.forEach(p=>{
        const ln=Math.max(0,(p.line||1)-1);
        if(!lineClasses[ln]||p.sev==='e')lineClasses[ln]=p.sev;
        const marker=document.createElement('div');marker.className='lint-marker '+p.sev;marker.textContent=p.sev==='e'?'\u2717':'\u26A0';
        marker.title=(p.sev==='e'?'Error':'Warning')+': '+p.msg;
        marker.addEventListener('mouseenter',ev=>showLintTooltip(ev,ln,probs));
        marker.addEventListener('mouseleave',()=>hideLintTooltip());
        editor.setGutterMarker(ln,'lint-gutter',marker);
    });
    for(let i=0;i<editor.lineCount();i++){
        editor.removeLineClass(i,'background','lint-error-line');
        editor.removeLineClass(i,'background','lint-warning-line');
    }
    Object.entries(lineClasses).forEach(([ln,sev])=>{
        editor.addLineClass(parseInt(ln),'background',sev==='e'?'lint-error-line':'lint-warning-line');
    });
}
function showLintTooltip(ev,line,probs){
    const tip=document.getElementById('lintTip');
    const lineProbs=probs.filter(p=>(p.line||1)-1===line);
    if(!lineProbs.length){tip.style.display='none';return}
    tip.innerHTML=lineProbs.map(p=>'<div class="lint-tooltip-item"><div class="lint-tooltip-icon '+p.sev+'">'+(p.sev==='e'?'\u2717':'\u26A0')+'</div><div><div class="lint-tooltip-msg">'+escH(p.msg)+'</div>'+(p.source?'<div class="lint-tooltip-src">'+escH(p.source)+'</div>':'')+'</div></div>').join('');
    const rect=ev.target.getBoundingClientRect();tip.style.left=(rect.right+8)+'px';tip.style.top=rect.top+'px';tip.style.display='block';
    const tipR=tip.getBoundingClientRect();if(tipR.right>innerWidth)tip.style.left=(rect.left-tipR.width-8)+'px';if(tipR.bottom>innerHeight)tip.style.top=(innerHeight-tipR.height-8)+'px';
}
function hideLintTooltip(){document.getElementById('lintTip').style.display='none'}
function updateLintUI(){
    let totalE=0,totalW=0;Object.values(allProblems).forEach(arr=>{arr.forEach(p=>{if(p.sev==='e')totalE++;else totalW++})});
    const badge=document.getElementById('lintBadge'),btn=document.getElementById('lintBtn');
    const sl=document.getElementById('statusLint');
    btn.classList.remove('has-errors','has-warnings','lint-ok');
    if(totalE){badge.textContent=totalE;badge.className='lint-badge errors';badge.style.display='';btn.classList.add('has-errors');sl.innerHTML='<span style="color:#f87171">\u2717 '+totalE+' error'+(totalE>1?'s':'')+'</span>'}
    else if(totalW){badge.textContent=totalW;badge.className='lint-badge warnings';badge.style.display='';btn.classList.add('has-warnings');sl.innerHTML='<span style="color:#fbbf24">\u26A0 '+totalW+' warning'+(totalW>1?'s':'')+'</span>'}
    else{badge.textContent='\u2713';badge.className='lint-badge ok';badge.style.display='';btn.classList.add('lint-ok');sl.innerHTML='<span style="color:#34d399">\u2713 No issues</span>'}
    renderProblemsPanel();
}
function renderProblemsPanel(){
    const list=document.getElementById('probList');let allP=[];
    Object.entries(allProblems).forEach(([file,probs])=>{probs.forEach(p=>allP.push({...p,file}))});
    if(probFilter!=='all')allP=allP.filter(p=>p.sev===probFilter);
    const cnt=document.getElementById('probCnt');
    const ec=allP.filter(p=>p.sev==='e').length,wc=allP.filter(p=>p.sev==='w').length;
    if(ec){cnt.className='cnt e';cnt.textContent=ec+' error'+(ec>1?'s':'')}
    else if(wc){cnt.className='cnt w';cnt.textContent=wc+' warning'+(wc>1?'s':'')}
    else{cnt.className='cnt ok';cnt.textContent='0'}
    list.innerHTML=allP.map(p=>'<div class="prob-item '+p.sev+'" onclick="jumpToProblem(\''+esc(p.file)+'\','+(p.line||1)+')"><div class="p-icon '+p.sev+'">'+(p.sev==='e'?'\u2717':'\u26A0')+'</div><div class="p-msg">'+escH(p.msg)+(p.source?' <span class="p-src">('+escH(p.source)+')</span>':'')+'</div><span class="p-file">'+escH(p.file.split('/').pop())+'</span><span class="p-loc">:'+p.line+'</span></div>').join('');
}
function jumpToProblem(file,line){openEditorTab(file,line)}
function setProbFilter(f){probFilter=f;document.querySelectorAll('.problems-actions [data-f]').forEach(b=>{b.classList.toggle('toggled',b.dataset.f===f)});renderProblemsPanel()}
function toggleProblemsPanel(){const p=document.getElementById('problemsPanel');probCollapsed=!probCollapsed;p.classList.toggle('collapsed',probCollapsed)}
function clearAllProblems(){allProblems={};updateLintUI();if(activeTab&&activeTab.type==='editor')applyLintDecorations(activeTab);renderTabs();renderSidebarTree()}

// --- PROBLEMS RESIZE ---
(function(){const rz=document.getElementById('problemsResize'),pp=document.getElementById('problemsPanel');let startY,startH;
rz.addEventListener('mousedown',e=>{e.preventDefault();startY=e.clientY;startH=pp.offsetHeight;rz.classList.add('active');
document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp)});
function onMove(e){const h=Math.max(28,startH+(startY-e.clientY));pp.style.height=h+'px'}
function onUp(){rz.classList.remove('active');document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp)}})();

// --- MINIMAP ---
function renderMinimap(){
    if(!activeTab||activeTab.type!=='editor')return;
    const canvas=document.getElementById('minimapCanvas'),ctx=canvas.getContext('2d');
    const lines=editor.lineCount(),lineH=2,w=120;
    canvas.width=w*devicePixelRatio;canvas.height=Math.min(lines*lineH,50000)*devicePixelRatio;
    canvas.style.width=w+'px';canvas.style.height=Math.min(lines*lineH,50000)+'px';
    ctx.scale(devicePixelRatio,devicePixelRatio);ctx.fillStyle='#0a0e14';ctx.fillRect(0,0,w,lines*lineH);
    const colors={'keyword':'#c792ea','string':'#c3e88d','number':'#f78c6c','comment':'#546e7a','atom':'#f78c6c','variable':'#eeffff','variable-2':'#82aaff','def':'#82aaff','tag':'#f07178','attribute':'#c792ea','property':'#89ddff','operator':'#89ddff','type':'#ffcb6b'};
    const probLines={};(allProblems[activeTab.path]||[]).forEach(p=>{const ln=(p.line||1)-1;if(!probLines[ln]||p.sev==='e')probLines[ln]=p.sev});
    for(let i=0;i<lines&&i*lineH<50000;i++){
        const y=i*lineH;
        if(probLines[i]){ctx.fillStyle=probLines[i]==='e'?'rgba(248,113,113,0.3)':'rgba(251,191,36,0.2)';ctx.fillRect(0,y,w,lineH)}
        const tokens=editor.getLineTokens(i);let x=0;
        tokens.forEach(t=>{const tw=t.string.length*0.7;ctx.fillStyle=colors[t.type]||'#5c6f85';ctx.fillRect(8+x*0.7,y,tw,lineH>1?lineH-0.5:1);x+=t.string.length});
    }
    Object.entries(probLines).forEach(([ln,sev])=>{
        const el=document.createElement('div');el.className='minimap-err '+sev;el.style.top=(ln*lineH)+'px';
        document.getElementById('minimap').appendChild(el);
    });
    minimapDirty=false;
}
function updateMinimapViewport(){
    if(!activeTab||activeTab.type!=='editor')return;
    const vp=document.getElementById('minimapViewport');
    const canvas=document.getElementById('minimapCanvas');
    const mm=document.getElementById('minimap');
    const si=editor.getScrollInfo();
    if(!si.height)return;
    const lineH=2;
    const totalH=editor.lineCount()*lineH;
    const mmH=mm.clientHeight;
    const vpH=Math.max(24,(si.clientHeight/si.height)*totalH);
    const editorMaxScroll=si.height-si.clientHeight;
    const ratio=editorMaxScroll>0?si.top/editorMaxScroll:0;
    const canvasMaxScroll=Math.max(0,totalH-mmH);
    const canvasOffset=ratio*canvasMaxScroll;
    const vpTopOnCanvas=(si.top/si.height)*totalH;
    canvas.style.top=(-canvasOffset)+'px';
    vp.style.top=Math.round(vpTopOnCanvas-canvasOffset)+'px';
    vp.style.height=Math.round(vpH)+'px';
}
(function(){
    const mm=document.getElementById('minimap');
    const vp=document.getElementById('minimapViewport');
    let dragging=false, dragStartY=0, dragStartScrollTop=0;
    vp.style.pointerEvents='none';
    function getCanvasOffset(){return -(parseInt(document.getElementById('minimapCanvas').style.top||'0'))}
    function editorScrollFromMinimapY(y){
        const si=editor.getScrollInfo();
        const lineH=2, totalH=editor.lineCount()*lineH;
        const canvasAbsY=y+getCanvasOffset();
        const ratio=Math.max(0,Math.min(1,canvasAbsY/totalH));
        editor.scrollTo(null,ratio*(si.height-si.clientHeight));
    }
    mm.addEventListener('mousedown',function(e){
        e.preventDefault();
        const rect=mm.getBoundingClientRect();
        const y=e.clientY-rect.top;
        const vpTop=parseInt(vp.style.top||'0');
        const vpH=parseInt(vp.style.height||'0');
        if(y>=vpTop&&y<=vpTop+vpH){dragging=true;dragStartY=e.clientY;dragStartScrollTop=editor.getScrollInfo().top;document.body.style.userSelect='none';}
        else{editorScrollFromMinimapY(y)}
    });
    document.addEventListener('mousemove',function(e){
        if(!dragging)return;
        const si=editor.getScrollInfo();
        const lineH=2, totalH=editor.lineCount()*lineH;
        const mmH=mm.clientHeight;
        const vpH=parseInt(vp.style.height||'0');
        const sliderTravel=Math.max(1,mmH-vpH);
        const editorMaxScroll=si.height-si.clientHeight;
        const dy=e.clientY-dragStartY;
        const newScroll=Math.max(0,Math.min(editorMaxScroll,dragStartScrollTop+dy*(editorMaxScroll/sliderTravel)));
        editor.scrollTo(null,newScroll);
    });
    document.addEventListener('mouseup',function(){if(dragging){dragging=false;document.body.style.userSelect='';}});
})();

// --- FIND/REPLACE ---
function openFindBar(withReplace){
    document.getElementById('findBar').classList.add('visible');
    const inp=document.getElementById('findInput');inp.focus();inp.select();
    if(withReplace)document.getElementById('replaceInput').style.display='';
}
function closeFindBar(){
    document.getElementById('findBar').classList.remove('visible');
    if(findOverlay){editor.removeOverlay(findOverlay);findOverlay=null}
    findMatches=[];findCurrentIdx=-1;document.getElementById('findInfo').textContent='';editor.focus();
}
function doFind(){
    const q=document.getElementById('findInput').value;if(!q)return;
    if(findOverlay){editor.removeOverlay(findOverlay);findOverlay=null}
    findOverlay={token:function(stream){
        const flags=findCaseSensitive?'':'i';const re=new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),flags);
        const match=stream.string.slice(stream.pos).match(re);
        if(match&&match.index===0){stream.pos+=match[0].length;return'find-match'}
        if(match)stream.pos+=match.index;else stream.skipToEnd();return null;
    }};
    editor.addOverlay(findOverlay);
    const cur=editor.getSearchCursor(q,editor.getCursor(),{caseFold:!findCaseSensitive});
    if(cur.findNext()){editor.setSelection(cur.from(),cur.to());editor.scrollIntoView({from:cur.from(),to:cur.to()},60)}
    else{const cur2=editor.getSearchCursor(q,{line:0,ch:0},{caseFold:!findCaseSensitive});if(cur2.findNext()){editor.setSelection(cur2.from(),cur2.to());editor.scrollIntoView({from:cur2.from(),to:cur2.to()},60)}}
    countMatches(q);
}
function doReplace(){
    const q=document.getElementById('findInput').value,r=document.getElementById('replaceInput').value;if(!q)return;
    const sel=editor.getSelection();
    const match=findCaseSensitive?sel===q:sel.toLowerCase()===q.toLowerCase();
    if(match)editor.replaceSelection(r);
    doFind();
}
function doReplaceAll(){
    const q=document.getElementById('findInput').value,r=document.getElementById('replaceInput').value;if(!q)return;
    let count=0;const cur=editor.getSearchCursor(q,{line:0,ch:0},{caseFold:!findCaseSensitive});
    while(cur.findNext()){cur.replace(r);count++}
    document.getElementById('findInfo').textContent=count+' replaced';if(findOverlay){editor.removeOverlay(findOverlay);findOverlay=null}
}
function countMatches(q){
    const flags='g'+(findCaseSensitive?'':'i');const re=new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),flags);
    const txt=editor.getValue();const m=txt.match(re);
    document.getElementById('findInfo').textContent=(m?m.length:0)+' matches';
}
function toggleCaseSensitive(){findCaseSensitive=!findCaseSensitive;document.getElementById('caseSensitiveBtn').classList.toggle('toggled',findCaseSensitive);const q=document.getElementById('findInput').value;if(q)doFind()}
document.getElementById('findInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();doFind()}if(e.key==='Escape')closeFindBar()});
document.getElementById('replaceInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();doReplace()}if(e.key==='Escape')closeFindBar()});
document.getElementById('findInput').addEventListener('input',()=>{if(document.getElementById('autoFindCheckbox').checked)doFind()});

// --- BROWSER TAB ---
function openBrowserTab(path){
    let existing=tabs.find(t=>t.type==='browser'&&t.path===path);
    if(existing){switchTab(existing);return}
    const tab={type:'browser',path,items:[],selected:new Set(),sortCol:'name',sortAsc:true,view:'list',scrollTop:0,searchFilter:''};
    tabs.push(tab);switchTab(tab);browserLoadDir(tab);
}
function browserNavigate(path){
    if(activeTab&&activeTab.type==='browser'){activeTab.path=path;activeTab.selected=new Set();activeTab.lastClickedPath='';activeTab.scrollTop=0;browserLoadDir(activeTab);renderTabs();updateUrl()}
    else openBrowserTab(path);
}
async function browserLoadDir(tab){
    const r=await api({action:'list',path:tab.path});
    if(!r.ok){toast('Error loading dir','error');return}
    tab.items=r.items||[];
    if(tab.lastClickedPath&&!tab.items.some(i=>i.path===tab.lastClickedPath))tab.lastClickedPath='';
    renderBrowserTab();
}
function browserVisibleItems(tab){
    let items=[...tab.items];
    const f=tab.searchFilter?tab.searchFilter.toLowerCase():'';
    if(f)items=items.filter(i=>i.name.toLowerCase().includes(f));
    const col=tab.sortCol,asc=tab.sortAsc;
    items.sort((a,b)=>{
        if(a.isDir!==b.isDir)return a.isDir?-1:1;
        let v=0;
        if(col==='name')v=a.name.localeCompare(b.name,undefined,{sensitivity:'base'});
        else if(col==='size')v=(a.size||0)-(b.size||0);
        else if(col==='modified')v=(parseInt(a.mtime)||0)-(parseInt(b.mtime)||0);
        return asc?v:-v;
    });
    return items;
}
function renderBrowserTab(){
    if(!activeTab||activeTab.type!=='browser')return;
    const tab=activeTab;
    const parts=tab.path?tab.path.split('/'):[];
    let bc='<a onclick="browserNavigate(\'\')">Root</a>';
    let cur='';
    parts.forEach((p,i)=>{cur+=(i?'/':'')+p;if(i<parts.length-1)bc+='<span class="bsep">/</span><a onclick="browserNavigate(\''+esc(cur)+'\')">'+escH(p)+'</a>';else bc+='<span class="bsep">/</span><span class="bcurrent">'+escH(p)+'</span>'});
    document.getElementById('browserBreadcrumb').innerHTML=bc;
    const items=browserVisibleItems(tab);
    const selCount=tab.selected.size;
    const ab=document.getElementById('actionBar');ab.classList.toggle('visible',selCount>0);
    if(selCount)document.getElementById('actionCount').textContent=selCount+' selected';
    document.getElementById('btnDeleteB').disabled=!selCount;

    const fl=document.getElementById('fileList');
    if(tab.view==='grid'){
        fl.innerHTML='<div class="file-grid">'+items.map(it=>{
            const sel=tab.selected.has(it.path)?'selected':'';
            const isCut=clipboard.mode==='cut'&&clipboard.paths.includes(it.path)?' is-cut-item':'';
            const isSL=isSymlink(it),isBroken=isSymlinkBroken(it);
            const slCls=isSL?' is-symlink':'';const brkCls=isBroken?' broken-symlink':'';
            return'<div class="file-card '+sel+slCls+brkCls+isCut+'" onclick="browserItemClick(event,\''+esc(it.path)+'\')" ondblclick="browserItemDblClick(\''+esc(it.path)+'\','+it.isDir+')" oncontextmenu="event.preventDefault();showBrowserContextMenu(event,'+escA(JSON.stringify(it))+')" draggable="true" ondragstart="browserCardDragStart(event,\''+esc(it.path)+'\')"><div class="file-icon">'+fileIconGrid(it.name,it.isDir,it.path)+(isSL?'<span class="sl-overlay-grid">\u{1F517}</span>':'')+'</div><div class="file-name">'+escH(it.name)+'</div></div>';
        }).join('')+'</div>';
    }else{
        let th='<thead><tr>';
        ['name','size','modified'].forEach(c=>{
            const sorted=tab.sortCol===c;
            th+='<th class="'+(sorted?'sorted':'')+'" onclick="browserSort(\''+c+'\')">'+c.charAt(0).toUpperCase()+c.slice(1)+(sorted?' <span class="sort-arrow">'+(tab.sortAsc?'\u25B2':'\u25BC')+'</span>':'')+'</th>';
        });
        th+='<th></th></tr></thead>';
        let tbody='<tbody>'+items.map(it=>{
            const sel=tab.selected.has(it.path)?'selected':'';
            const isCut=clipboard.mode==='cut'&&clipboard.paths.includes(it.path)?' is-cut-item':'';
            const isSL=isSymlink(it),isBroken=isSymlinkBroken(it);
            const slCls=isSL?' is-symlink-row':'';
            const nameCls=isSL?(isBroken?'symlink-name broken':'symlink-name'):'';
            const slTarget=isSL?'<span class="symlink-target">\u2192 '+escH(symlinkTarget(it))+'</span>':'';
            const fav=isFav(it.path);
            return'<tr class="'+sel+slCls+isCut+'" onclick="browserItemClick(event,\''+esc(it.path)+'\')" ondblclick="browserItemDblClick(\''+esc(it.path)+'\','+it.isDir+')" oncontextmenu="event.preventDefault();showBrowserContextMenu(event,'+escA(JSON.stringify(it))+')" draggable="true" ondragstart="browserRowDragStart(event,\''+esc(it.path)+'\')" ondragover="browserRowDragOver(event,'+it.isDir+',\''+esc(it.path)+'\')" ondragleave="browserRowDragLeave(event)" ondrop="browserRowDrop(event,\''+esc(it.path)+'\')"><td><div class="name-cell"><span class="fav-star'+(fav?' active':'')+'" onclick="event.stopPropagation();toggleFavorite(\''+esc(it.path)+'\',\''+esc(it.name)+'\','+it.isDir+')">\u2605</span><span class="ficon">'+fileIconHtml(it.name,it.isDir,it.path)+'</span><span class="fname '+nameCls+'">'+escH(it.name)+'</span>'+slTarget+'</div></td><td class="muted">'+(it.isDir?'\u2014':formatSize(it.size))+'</td><td class="muted">'+formatDate(it.mtime)+'</td><td></td></tr>';
        }).join('')+'</tbody>';
        fl.innerHTML='<table class="file-table">'+th+tbody+'</table>';
    }
    document.getElementById('btnListView').classList.toggle('active',tab.view==='list');
    document.getElementById('btnGridView').classList.toggle('active',tab.view==='grid');
}
function formatSize(b){if(b==null)return'\u2014';if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';return(b/1073741824).toFixed(2)+' GB'}
async function calculateDirectorySize(item){
    if(!item||!item.isDir)return;
    const label=item.path?'/'+item.path:'/';
    const taskId=createTask('Folder size',item.name||'Root','Calculating '+label);
    const started=performance.now();
    const r=await api({action:'dir_size',path:item.path||''});
    const elapsed=((performance.now()-started)/1000).toFixed(1)+'s';
    if(r.ok){
        const files=r.files||0, dirs=r.dirs||0;
        const parts=[files+' file'+(files===1?'':'s'),dirs+' folder'+(dirs===1?'':'s')];
        if(r.errors)parts.push(r.errors+' unreadable');
        updateTask(taskId,{state:'success',detail:'Calculated '+label,result:r.sizeH||formatSize(r.size),meta:parts.join(' · ')+' · '+(r.elapsed!=null?r.elapsed+'s':elapsed)});
    }else{
        updateTask(taskId,{state:'error',detail:'Could not calculate '+label,result:r.error||'Unknown error',meta:elapsed});
    }
}
async function calculateDirectorySize(item){
    if(!item||!item.isDir)return;
    const label=item.path?'/'+item.path:'/';
    const taskId=createTask('Folder size',item.name||'Root','Starting '+label);
    const r=await api({action:'dir_size_start',path:item.path||''});
    if(!r.ok){
        updateTask(taskId,{state:'error',detail:'Could not start '+label,result:r.error||'Unknown error'});
        return;
    }
    updateTask(taskId,{detail:'Queued '+label,meta:'Job '+r.jobId});
    pollDirectorySizeJob(r.jobId,taskId,label);
}
async function pollDirectorySizeJob(jobId,taskId,label){
    if(!longTasks.some(t=>t.id===taskId))return;
    const r=await api({action:'dir_size_status',job:jobId});
    if(!r.ok){
        updateTask(taskId,{state:'error',detail:'Could not check '+label,result:r.error||'Unknown error'});
        return;
    }
    const job=r.job||{};
    const files=job.files||0, dirs=job.dirs||0;
    const parts=[files+' file'+(files===1?'':'s'),dirs+' folder'+(dirs===1?'':'s')];
    if(job.errors)parts.push(job.errors+' unreadable');
    if(job.elapsed!=null)parts.push(job.elapsed+'s');
    if(job.status==='done'){
        updateTask(taskId,{state:'success',detail:'Calculated '+label,result:job.sizeH||formatSize(job.size),meta:parts.join(' · ')});
        return;
    }
    if(job.status==='error'){
        updateTask(taskId,{state:'error',detail:'Could not calculate '+label,result:job.error||'Unknown error',meta:parts.join(' · ')});
        return;
    }
    updateTask(taskId,{state:'running',detail:job.message||'Scanning '+label,result:job.sizeH||'',meta:parts.join(' · ')});
    setTimeout(()=>pollDirectorySizeJob(jobId,taskId,label),1500);
}
function formatDate(ts){
    if(!ts)return '—';
    // If it's already a formatted string (not a number), return as-is
    if(isNaN(ts))return ts;
    const d=new Date(parseInt(ts)*1000);
    return d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})+
        ' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
}
    
function browserSort(col){if(!activeTab)return;if(activeTab.sortCol===col)activeTab.sortAsc=!activeTab.sortAsc;else{activeTab.sortCol=col;activeTab.sortAsc=true}renderBrowserTab()}
function setBrowserView(v){if(activeTab)activeTab.view=v;renderBrowserTab()}
function browserItemClick(e,path){
    if(!activeTab)return;
    if(e.ctrlKey||e.metaKey){if(activeTab.selected.has(path))activeTab.selected.delete(path);else activeTab.selected.add(path)}
    else if(e.shiftKey&&activeTab.lastClickedPath){
        const items=browserVisibleItems(activeTab).map(i=>i.path);
        const a=items.indexOf(activeTab.lastClickedPath),b=items.indexOf(path);
        if(a>=0&&b>=0){const [s,e2]=[Math.min(a,b),Math.max(a,b)];for(let i=s;i<=e2;i++)activeTab.selected.add(items[i])}
    }else{activeTab.selected=new Set([path])}
    activeTab.lastClickedPath=path;renderBrowserTab();
}
function browserItemDblClick(path,isDir){if(isDir)browserNavigate(path);else openEditorTab(path)}
function browserGoUp(){if(!activeTab||activeTab.type!=='browser')return;const p=activeTab.path;const up=p?p.substring(0,p.lastIndexOf('/')):'';if(p!==up||p)browserNavigate(up)}
function browserRefresh(){if(activeTab&&activeTab.type==='browser'){sidebarCache={};browserLoadDir(activeTab);loadSidebar()}}
function browserClearSelection(){if(activeTab)activeTab.selected=new Set();renderBrowserTab()}
document.getElementById('browserSearchInput').addEventListener('input',e=>{if(activeTab&&activeTab.type==='browser'){activeTab.searchFilter=e.target.value;renderBrowserTab()}});

async function browserDeleteSelected(){
    if(!activeTab||!activeTab.selected.size)return;
    const paths=[...activeTab.selected];
    await moveItemsToTrash(paths);
    activeTab.selected=new Set();
    await browserLoadDir(activeTab);loadSidebar();
}
function browserOpenAllSelected(){
    if(!activeTab)return;
    [...activeTab.selected].forEach(p=>{const it=activeTab.items.find(i=>i.path===p);if(it&&!it.isDir)openEditorTab(p)});
}
async function browserCopyAllContents(){
    if(!activeTab)return;let all='';
    for(const p of activeTab.selected){const it=activeTab.items.find(i=>i.path===p);if(it&&!it.isDir){const r=await api({action:'read',path:p});if(r.ok!==false)all+='// --- '+p+' ---\n'+r.content+'\n\n'}}
    if(all){navigator.clipboard.writeText(all);toast('Contents copied','success')}
}
async function browserDownloadSelected(){
    if(!activeTab || !activeTab.selected.size) return;

    const paths = [...activeTab.selected];

    // Check if any directories are selected
    const hasDirs = paths.some(p => {
        const it = activeTab.items.find(i => i.path === p);
        return it && it.isDir;
    });

    // If directories present, or multiple items, use zip download
    if(hasDirs || paths.length > 1){
        toast('Creating zip archive...', 'info');
        const pathsStr = paths.join(',');
        const a = document.createElement('a');
        a.href = API + '?action=download_zip&paths=' + encodeURIComponent(pathsStr);
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast('Zip download started for ' + paths.length + ' item(s)', 'success');
        return;
    }

    // Single file — use direct download
    const BATCH_SIZE = 8;
    const BETWEEN_MS = 1200;
    const PER_FILE_MS = 120;

    function sleep(ms){
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    for(let i = 0; i < paths.length; i += BATCH_SIZE){
        const batch = paths.slice(i, i + BATCH_SIZE);

        for(let j = 0; j < batch.length; j++){
            const p = batch[j];
            const a = document.createElement('a');
            a.href = API + '?action=download&path=' + encodeURIComponent(p);
            a.download = '';
            document.body.appendChild(a);
            a.click();
            a.remove();

            if(j < batch.length - 1){
                await sleep(PER_FILE_MS);
            }
        }

        if(i + BATCH_SIZE < paths.length){
            toast('Downloading batch ' + (Math.floor(i / BATCH_SIZE) + 1) + '...', 'info');
            await sleep(BETWEEN_MS);
        }
    }

    toast('Started download for ' + paths.length + ' file(s)', 'success');
}
function downloadAsZip(path){
    toast('Creating zip archive...','info');
    const a=document.createElement('a');
    a.href=API+'?action=download_zip&path='+encodeURIComponent(path);
    a.download='';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Zip download started','success');
}
async function extractArchive(path){
    toast('Extracting archive...','info');
    const taskId=createTask('Extract archive',path.split('/').pop(),'Extracting /'+path);
    const r=await api({action:'extract',path});
    if(r.ok){
        updateTask(taskId,{state:'success',detail:'Extraction finished',result:r.extracted>0?r.extracted+' files':'Done',meta:'Created '+(r.path||'output folder')});
        toast('Extracted '+(r.extracted>0?r.extracted+' files':'successfully')+'!','success');
        loadSidebar();
        if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab);
    }else{
        updateTask(taskId,{state:'error',detail:'Extraction failed',result:r.error||'Unknown error'});
        toast('Extract failed: '+(r.error||'Unknown error'),'error');
    }
}
function browserRowDragStart(e,path){
    const tab=activeTab;if(!tab)return;
    if(tab.selected.has(path))browserDraggedPaths=[...tab.selected];else browserDraggedPaths=[path];
    e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',JSON.stringify(browserDraggedPaths));
}
function browserCardDragStart(e,path){browserRowDragStart(e,path)}
function browserRowDragOver(e,isDir,path){if(!isDir||browserDraggedPaths.includes(path))return;e.preventDefault();e.currentTarget.classList.add('drag-target')}
function browserRowDragLeave(e){e.currentTarget.classList.remove('drag-target')}
async function browserRowDrop(e,targetDir){
    e.preventDefault();e.currentTarget.classList.remove('drag-target');
    if(!browserDraggedPaths.length)return;
    for(const p of browserDraggedPaths){
        const name=p.split('/').pop();const newPath=(targetDir?targetDir+'/':'')+name;
        if(newPath===p)continue;
        // FIX: use action:'rename' with newPath param (matches fixed backend)
        await api({action:'rename',path:p,newPath});
    }
    browserDraggedPaths=[];browserRefresh();
}

function showBrowserContextMenu(e,item){
    closeContextMenu();
    const isSL=isSymlink(item);
    const hasSel=activeTab&&activeTab.selected.size>1&&activeTab.selected.has(item.path);
    let h='<div class="context-menu" id="ctxMenu" style="left:'+e.clientX+'px;top:'+e.clientY+'px">';
    if(item.isDir){
        h+=cmi('\u{1F4C2}','Open','',()=>browserNavigate(item.path));
        h+=cmi('\u{1F4D1}','Open in New Tab','',()=>openBrowserTab(item.path));
        h+=cmi('\u{1F4CF}','Calculate Folder Size','',()=>calculateDirectorySize(item));
        h+=cmi('\u{1F4E5}','Download as Zip','',()=>downloadAsZip(item.path));
    }else{
        h+=cmi('\u270F\uFE0F','Edit','',()=>openEditorTab(item.path));
        const pt=getPreviewType(item.name);if(pt)h+=cmi('\u{1F441}\uFE0F','Preview','',()=>previewFile(item));
        h+=cmi('\u{1F4E5}','Download','',()=>{const a=document.createElement('a');a.href=API+'?action=download&path='+encodeURIComponent(item.path);a.download='';document.body.appendChild(a);a.click();a.remove()});
        if(isArchive(item.name))h+=cmi('\u{1F4E6}','Extract Here','',()=>extractArchive(item.path));
    }
    h+='<div class="menu-divider"></div>';
    // Copy / Cut
    const targets=hasSel?[...activeTab.selected]:[item.path];
    const targetLabel=targets.length>1?targets.length+' items':'"'+item.name+'"';
    h+=cmi('\u{1F4CB}','Copy '+targetLabel,'Ctrl+C',()=>{
        if(!hasSel)activeTab.selected=new Set([item.path]);
        copySelected();
    });
    h+=cmi('\u2702\uFE0F','Cut '+targetLabel,'Ctrl+X',()=>{
        if(!hasSel)activeTab.selected=new Set([item.path]);
        cutSelected();
    });
    if(clipboard.paths.length){
        if(item.isDir){
            h+=cmi('\u{1F4CB}','Paste into "'+item.name+'"','',()=>pasteFiles(item.path));
        }
        h+=cmi('\u{1F4CB}','Paste here','Ctrl+V',()=>pasteFiles(activeTab.path));
    }
    h+='<div class="menu-divider"></div>';
    if(isSL){
        h+=cmi('\u{1F517}','Symlink Info','',()=>showSymlinkInfoModal(item));
        h+=cmi('\u270F\uFE0F','Edit Symlink','',()=>promptEditSymlink(item));
    }
    h+=cmi('\u270F\uFE0F','Rename','',()=>startRename(item));
    h+=cmi('\u{1F4CB}','Copy Path','',()=>{navigator.clipboard.writeText(item.path);toast('Path copied','info')});
    h+=cmi(isFav(item.path)?'\u{1F49B}':'\u2B50',isFav(item.path)?'Unfavorite':'Favorite','',()=>toggleFavorite(item.path,item.name,item.isDir));
    h+=cmi('\u2139\uFE0F','Info','',()=>showInfoPanel(item));
    h+='<div class="menu-divider"></div>';
    h+=cmi('\u{1F5D1}\uFE0F','Move to Trash','',()=>{
        if(hasSel)moveItemsToTrash([...activeTab.selected]);
        else moveItemToTrash(item);
    },'','danger');
    h+='</div>';
    document.body.insertAdjacentHTML('beforeend',h);
    const menu=document.getElementById('ctxMenu'),r=menu.getBoundingClientRect();
    if(r.right>innerWidth)menu.style.left=(e.clientX-r.width)+'px';if(r.bottom>innerHeight)menu.style.top=(e.clientY-r.height)+'px';
}

// --- CONTEXT MENU HELPER ---
let _cmiId=0;
function cmi(icon,label,shortcut,handler,cls,extraCls){
    const id='cmi_'+(++_cmiId);
    setTimeout(()=>{const el=document.getElementById(id);if(el)el.addEventListener('click',()=>{closeContextMenu();handler()})},0);
    return'<div class="menu-item '+(extraCls||'')+'" id="'+id+'"><span class="mi">'+icon+'</span>'+escH(label)+(shortcut?'<span class="shortcut">'+shortcut+'</span>':'')+'</div>';
}
function closeContextMenu(){const m=document.getElementById('ctxMenu');if(m)m.remove();_cmiId=0}
document.addEventListener('click',()=>closeContextMenu());

// --- FAVORITES ---
function isFav(p){return favorites.some(f=>f.path===p)}
function saveFavorites(){localStorage.setItem('ide_favorites',JSON.stringify(favorites));renderFavorites();if(activeTab&&activeTab.type==='browser')renderBrowserTab()}
function addFavorite(path,name,isDir){if(!favorites.some(f=>f.path===path)){favorites.push({path,name,isDir});saveFavorites();toast('Favorited','success')}}
function removeFavorite(path){favorites=favorites.filter(f=>f.path!==path);saveFavorites()}
function toggleFavorite(path,name,isDir){isFav(path)?removeFavorite(path):addFavorite(path,name||path.split('/').pop(),isDir||false)}
function clearAllFavorites(){if(favorites.length&&confirm('Clear all favorites?')){favorites=[];saveFavorites()}}
function renderFavorites(){
    const list=document.getElementById('favList');
    if(!favorites.length){list.innerHTML='<div class="fav-empty">Right-click \u2192 Favorite</div>';return}
    list.innerHTML=favorites.map(f=>{const icon=f.isDir?'\u{1F4C1}':fileIconTree(f.name,false,f.path);const action=f.isDir?'openBrowserTab(\''+escA(f.path)+'\')':'openEditorTab(\''+escA(f.path)+'\')';return'<div class="fav-item" onclick="'+action+'" title="'+escA(f.path)+'"><span class="fav-icon">'+icon+'</span><span class="fav-name">'+escH(f.name)+'</span><span class="fav-remove" onclick="event.stopPropagation();removeFavorite(\''+escA(f.path)+'\')">\u2715</span></div>'}).join('');
}

// --- INFO PANEL ---
function showInfoPanel(item){
    const panel=document.getElementById('infoPanel');
    infoPanelVisible=!infoPanelVisible;panel.classList.toggle('visible',infoPanelVisible);
    if(!infoPanelVisible)return;
    let h='<h4>'+escH(item.name)+'</h4>';
    h+='<div class="info-icon">'+fileIcon(item.name,item.isDir)+'</div>';
    if(!item.isDir&&isImage(item.name))h+='<img class="preview-thumb" src="'+thumbUrl(item.path)+'" onerror="this.style.display=\'none\'">';
    h+='<div class="info-row"><span class="info-label">Path</span><span class="info-value">'+escH(item.path)+'</span></div>';
    h+='<div class="info-row"><span class="info-label">Type</span><span class="info-value">'+(item.isDir?'Directory':'File')+'</span></div>';
    if(!item.isDir)h+='<div class="info-row"><span class="info-label">Size</span><span class="info-value">'+formatSize(item.size)+'</span></div>';
    if(item.mtime)h+='<div class="info-row"><span class="info-label">Modified</span><span class="info-value">'+escH(item.mtime)+'</span></div>';
    if(item.perms)h+='<div class="info-row"><span class="info-label">Permissions</span><span class="info-value">'+escH(item.perms)+'</span></div>';
    if(isSymlink(item)){
        h+='<div class="info-symlink"><div class="isl-title">\u{1F517} Symlink</div>';
        h+='<div class="isl-target">'+escH(symlinkTarget(item))+'</div>';
        h+='<div class="isl-status '+(isSymlinkBroken(item)?'broken':'valid')+'">'+(isSymlinkBroken(item)?'\u2717 Broken':'\u2713 Valid')+'</div>';
        h+='<div class="isl-actions"><button class="btn" onclick="promptEditSymlink('+escA(JSON.stringify(item))+')">Edit</button><button class="btn" onclick="showSymlinkInfoModal('+escA(JSON.stringify(item))+')">Info</button></div></div>';
    }
    panel.innerHTML=h;
}

// --- PREVIEW ---
function previewFile(item){
    const pt=getPreviewType(item.name);if(!pt)return;
    const url=API+'?action=download&path='+encodeURIComponent(item.path);
    let media='';
    if(pt==='image')media='<img src="'+url+'" alt="'+escA(item.name)+'">';
    else if(pt==='video')media='<video src="'+url+'" controls autoplay></video>';
    else if(pt==='pdf')media='<iframe src="'+url+'"></iframe>';
    document.body.insertAdjacentHTML('beforeend','<div class="preview-overlay" id="previewOverlay" onclick="if(event.target===this)closePreview()"><div class="preview-close" onclick="closePreview()">\u2715</div><div class="preview-container"><div class="preview-header"><span>'+escH(item.name)+'</span><button class="btn" onclick="window.open(\''+url+'\')">Open in new tab</button></div>'+media+'</div></div>');
}
function closePreview(){const o=document.getElementById('previewOverlay');if(o)o.remove()}

// --- MODALS ---
function showModal(title,bodyHtml,onOk,okLabel){
    closeModal();
    document.body.insertAdjacentHTML('beforeend','<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this)closeModal()"><div class="modal"><div class="modal-header"><h3>'+escH(title)+'</h3><button class="btn icon" onclick="closeModal()">\u2715</button></div><div class="modal-body">'+bodyHtml+'</div><div class="modal-footer"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" id="modalOk">'+(okLabel||'OK')+'</button></div></div></div>');
    const doOk=()=>{if(onOk){onOk()}closeModal()};
    if(onOk){
      document.getElementById('modalOk').addEventListener('click',doOk);
      document.getElementById('modalOverlay').addEventListener('keydown',e=>{
        if(e.key==='Enter'){e.preventDefault();doOk()}
        if(e.key==='Escape')closeModal()
      });
    }
}
function closeModal(){const m=document.getElementById('modalOverlay');if(m)m.remove()}

// --- RENAME ---
function startRename(item){
    showModal('Rename','<label>New name</label><input type="text" id="renameInput" value="'+escA(item.name)+'">',async()=>{
        const newName=document.getElementById('renameInput').value.trim();if(!newName||newName===item.name)return;
        const dir=item.path.substring(0,item.path.lastIndexOf('/'));
        // FIX: send newPath (full relative path) — matches fixed backend
        const newPath=(dir?dir+'/':'')+newName;
        const r=await api({action:'rename',path:item.path,newPath});
        if(r.ok!==false){
            toast('Renamed to '+newName,'success');
            tabs.forEach(t=>{if(t.path===item.path)t.path=newPath;else if(t.path.startsWith(item.path+'/'))t.path=newPath+t.path.substring(item.path.length)});
            renderTabs();updateUrl();
            if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab);loadSidebar();
        }else toast('Rename failed: '+(r.error||''),'error');
    },'Rename');
    setTimeout(()=>{const inp=document.getElementById('renameInput');inp.focus();const dot=inp.value.lastIndexOf('.');if(dot>0)inp.setSelectionRange(0,dot);else inp.select()},50);
}

// --- NEW FILE/FOLDER ---
function promptNewFile(){
    let dir='';if(activeTab){dir=activeTab.type==='browser'?activeTab.path:(activeTab.path?activeTab.path.substring(0,activeTab.path.lastIndexOf('/')):'');}
    showModal('New File','<label>File name</label><input type="text" id="newFileInput" placeholder="filename.txt"><div style="font-size:11px;color:var(--text3);margin-top:8px">In: /'+escH(dir)+'</div>',async()=>{
        const name=document.getElementById('newFileInput').value.trim();if(!name)return;
        const path=(dir?dir+'/':'')+name;
        // FIX: use action:'write' with empty content to create file (matches backend)
        const r=await apiPost(path,'');if(r.ok!==false){toast('Created '+name,'success');openEditorTab(path);loadSidebar();if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab)}else toast('Failed: '+(r.error||''),'error');
    },'Create');setTimeout(()=>document.getElementById('newFileInput').focus(),50);
}
function promptNewFolder(){
    let dir='';if(activeTab){dir=activeTab.type==='browser'?activeTab.path:(activeTab.path?activeTab.path.substring(0,activeTab.path.lastIndexOf('/')):'');}
    showModal('New Folder','<label>Folder name</label><input type="text" id="newFolderInput" placeholder="my-folder"><div style="font-size:11px;color:var(--text3);margin-top:8px">In: /'+escH(dir)+'</div>',async()=>{
        const name=document.getElementById('newFolderInput').value.trim();if(!name)return;
        const path=(dir?dir+'/':'')+name;
        // FIX: use action:'create_dir' (backend now has this alias after fix)
        const r=await api({action:'create_dir',path});if(r.ok!==false){toast('Created folder '+name,'success');loadSidebar();if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab)}else toast('Failed: '+(r.error||''),'error');
    },'Create');setTimeout(()=>document.getElementById('newFolderInput').focus(),50);
}
function promptNewFileInBrowser(){promptNewFile()}
function promptNewFolderInBrowser(){promptNewFolder()}

// --- FILE UPLOAD ---
// FIX: use field name 'files' (plural) to match backend's $_FILES['files'] check
document.getElementById('fileUploadInput').addEventListener('change',async function(){
    if(!this.files.length)return;
    const dir=activeTab&&activeTab.type==='browser'?activeTab.path:'';
    for(const file of this.files){
        const fd=new FormData();fd.append('files',file); // FIXED: was 'file'
        const r=await api({path:dir,formData:fd},{upload:true});
        if(r.ok!==false)toast('Uploaded '+file.name,'success');else toast('Upload failed: '+(r.error||''),'error');
    }
    this.value='';if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab);loadSidebar();
});

let _dragEnterCount=0;
document.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){_dragEnterCount++;document.getElementById('dropOverlay').classList.add('active')}});
document.addEventListener('dragleave',e=>{if(e.dataTransfer.types.includes('Files')){_dragEnterCount--;if(_dragEnterCount<=0){_dragEnterCount=0;document.getElementById('dropOverlay').classList.remove('active')}}});
document.addEventListener('drop',e=>{_dragEnterCount=0;document.getElementById('dropOverlay').classList.remove('active')});
document.addEventListener('dragend',e=>{_dragEnterCount=0;document.getElementById('dropOverlay').classList.remove('active')});
document.getElementById('dropOverlay').addEventListener('dragover',e=>e.preventDefault());
document.getElementById('dropOverlay').addEventListener('drop',async e=>{
    e.preventDefault();document.getElementById('dropOverlay').classList.remove('active');
    const dir=activeTab&&activeTab.type==='browser'?activeTab.path:'';
    for(const file of e.dataTransfer.files){
        const fd=new FormData();fd.append('files',file); // FIXED: was 'file'
        await api({path:dir,formData:fd},{upload:true});
    }
    if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab);loadSidebar();
});

// ═══════════════════════════════════════════════════
// TRASH SYSTEM
// ═══════════════════════════════════════════════════

async function moveItemToTrash(item){
    const r=await trashApi({action:'trash_move',path:item.path});
    if(r.ok){
        toast('Moved to trash: '+item.name,'success');
        for(let i=tabs.length-1;i>=0;i--){
            if(tabs[i].type==='editor'&&(tabs[i].path===item.path||tabs[i].path.startsWith(item.path+'/'))){
                if(activeTab===tabs[i]){activeTab=null}
                tabs.splice(i,1);
            }
        }
        if(!activeTab&&tabs.length)switchTab(tabs[0]);
        renderTabs();updateUrl();
        await loadSidebar();
        if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab);
        updateTrashDock();
        const trashTab=tabs.find(t=>t.type==='trash');
        if(trashTab&&activeTab===trashTab)loadTrashItems(trashTab);
    }else if(r.canHardDelete){
        confirmHardDelete([{path:item.path,name:item.name}]);
    }else{
        toast('Trash failed: '+(r.error||'Unknown'),'error');
    }
}

// Permanently delete items that couldn't be moved to trash (e.g. on another
// volume, where rename() can't cross the device boundary). Asks first.
function confirmHardDelete(items){
    const list=items.map(i=>'<li>'+escH(i.name)+'</li>').join('');
    const many=items.length>1;
    showModal(
        'Permanently delete?',
        '<p style="margin:0 0 8px">'+(many?items.length+' item'+(many?'s':''):'This item')+
        ' could not be moved to Trash (likely on a different volume).</p>'+
        '<p style="margin:0 0 8px">Delete '+(many?'them':'it')+
        ' <strong>permanently</strong>? This cannot be undone.</p>'+
        '<ul style="margin:0;padding-left:18px;max-height:160px;overflow:auto;color:var(--text2)">'+list+'</ul>',
        async()=>{
            let ok=0,fail=0;
            for(const it of items){
                const r=await api({action:'delete',path:it.path});
                if(r.ok!==false)ok++;else fail++;
            }
            if(ok)toast(ok+' item'+(ok>1?'s':'')+' permanently deleted','success');
            if(fail)toast(fail+' item'+(fail>1?'s':'')+' could not be deleted','error');
            for(let i=tabs.length-1;i>=0;i--){
                if(tabs[i].type==='editor'&&items.some(it=>tabs[i].path===it.path||tabs[i].path.startsWith(it.path+'/'))){
                    if(activeTab===tabs[i])activeTab=null;
                    tabs.splice(i,1);
                }
            }
            if(!activeTab&&tabs.length)switchTab(tabs[0]);
            renderTabs();updateUrl();
            await loadSidebar();
            if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab);
            updateTrashDock();
        },
        'Delete Permanently'
    );
}

async function moveItemsToTrash(paths){
    let ok=0,fail=0;const hardDeletable=[];
    for(const p of paths){
        const r=await trashApi({action:'trash_move',path:p});
        if(r.ok)ok++;
        else if(r.canHardDelete)hardDeletable.push({path:p,name:r.name||p.split('/').pop()});
        else fail++;
    }
    if(ok)toast(ok+' item'+(ok>1?'s':'')+' moved to trash','success');
    if(fail)toast(fail+' item'+(fail>1?'s':'')+' failed','error');
    for(let i=tabs.length-1;i>=0;i--){
        if(tabs[i].type==='editor'&&paths.some(p=>tabs[i].path===p||tabs[i].path.startsWith(p+'/'))){
            if(activeTab===tabs[i])activeTab=null;
            tabs.splice(i,1);
        }
    }
    if(!activeTab&&tabs.length)switchTab(tabs[0]);
    renderTabs();updateUrl();
    updateTrashDock();
    const trashTab=tabs.find(t=>t.type==='trash');
    if(trashTab&&activeTab===trashTab)loadTrashItems(trashTab);
    if(hardDeletable.length)confirmHardDelete(hardDeletable);
}

function openTrashTab(){
    let existing=tabs.find(t=>t.type==='trash');
    if(existing){switchTab(existing);return}
    const tab={type:'trash',path:'',items:[],selected:new Set(),searchFilter:''};
    tabs.push(tab);switchTab(tab);
}

async function loadTrashItems(tab){
    const search=tab.searchFilter||'';
    const r=await trashApi({action:'trash_list',search});
    if(!r.ok){toast('Error loading trash','error');return}
    tab.items=r.items||[];
    renderTrashItems(tab);
    const stats=await trashApi({action:'trash_stats'});
    if(stats.ok){
        document.getElementById('tsCount').textContent=stats.count;
        document.getElementById('tsTotalSize').textContent=stats.totalSizeH||'0 B';
        document.getElementById('trashTotalBadge').textContent=stats.count+' item'+(stats.count!==1?'s':'');
    }
}

function renderTrashItems(tab){
    const list=document.getElementById('trashList');
    if(!tab.items.length){
        list.innerHTML='<div class="trash-empty-state"><div class="tes-icon">\u{1F5D1}\uFE0F</div><div class="tes-text">Trash is empty</div><div class="tes-sub">Deleted files will appear here</div></div>';
        updateTrashSelectionUI(tab);return;
    }
    list.innerHTML=tab.items.map(it=>{
        const sel=tab.selected.has(it.id)?'selected':'';
        const icon=it.isDir?'\u{1F4C1}':fileIcon(it.originalName,false);
        return'<div class="trash-item '+sel+'" onclick="trashItemClick(event,\''+escA(it.id)+'\')" ondblclick="trashItemDblClick(\''+escA(it.id)+'\')">'+
            '<div class="ti-check" onclick="event.stopPropagation();trashToggleItem(\''+escA(it.id)+'\')">'+
            (tab.selected.has(it.id)?'\u2713':'')+'</div>'+
            '<div class="ti-icon">'+icon+'</div>'+
            '<div class="ti-info"><div class="ti-name">'+escH(it.originalName)+'</div>'+
            '<div class="ti-path">'+escH(it.parentDir||it.originalPath)+'</div></div>'+
            '<div class="ti-meta">'+
                '<span class="ti-size">'+escH(it.sizeH||'')+'</span>'+
                '<span class="ti-ago">'+escH(it.ago||'')+'</span>'+
            '</div>'+
            '<div class="ti-actions">'+
                '<button class="btn" onclick="event.stopPropagation();trashRestoreOne(\''+escA(it.id)+'\')">Restore</button>'+
                '<button class="btn danger" onclick="event.stopPropagation();trashDeleteOne(\''+escA(it.id)+'\')">Delete</button>'+
            '</div></div>';
    }).join('');
    updateTrashSelectionUI(tab);
}

function trashItemClick(e,id){
    const tab=tabs.find(t=>t.type==='trash');if(!tab)return;
    if(e.ctrlKey||e.metaKey){if(tab.selected.has(id))tab.selected.delete(id);else tab.selected.add(id)}
    else{tab.selected=new Set([id])}
    renderTrashItems(tab);
}
function trashItemDblClick(id){trashRestoreOne(id)}
function trashToggleItem(id){
    const tab=tabs.find(t=>t.type==='trash');if(!tab)return;
    if(tab.selected.has(id))tab.selected.delete(id);else tab.selected.add(id);
    renderTrashItems(tab);
}
function trashSelectAll(){
    const tab=tabs.find(t=>t.type==='trash');if(!tab)return;
    if(tab.selected.size===tab.items.length)tab.selected=new Set();
    else tab.selected=new Set(tab.items.map(i=>i.id));
    renderTrashItems(tab);
}
function trashClearSelection(){
    const tab=tabs.find(t=>t.type==='trash');if(!tab)return;
    tab.selected=new Set();renderTrashItems(tab);
}
function updateTrashSelectionUI(tab){
    const cnt=tab.selected.size;
    const ab=document.getElementById('trashActionBar');ab.classList.toggle('visible',cnt>0);
    document.getElementById('trashSelCount').textContent=cnt+' selected';
    document.getElementById('trashRestoreSelBtn').disabled=!cnt;
    document.getElementById('trashDeleteSelBtn').disabled=!cnt;
}

async function trashRestoreOne(id){
    const r=await trashApi({action:'trash_restore',id});
    if(r.ok){toast('Restored: '+(r.restoredTo||'').split('/').pop(),'success');refreshAfterTrashOp()}
    else toast('Restore failed: '+(r.error||''),'error');
}
async function trashDeleteOne(id){
    if(!confirm('Permanently delete this item? This cannot be undone.'))return;
    const r=await trashApi({action:'trash_delete',id});
    if(r.ok){toast('Permanently deleted','success');refreshAfterTrashOp()}
    else toast('Delete failed: '+(r.error||''),'error');
}
async function trashRestoreSelected(){
    const tab=tabs.find(t=>t.type==='trash');if(!tab||!tab.selected.size)return;
    const ids=[...tab.selected];
    const r=await trashApi({action:'trash_restore_multi',ids:ids.join(',')});
    if(r.ok){toast((r.restored||ids.length)+' item(s) restored','success');tab.selected=new Set();refreshAfterTrashOp()}
    else toast('Restore failed: '+(r.error||''),'error');
}
async function trashDeleteSelected(){
    const tab=tabs.find(t=>t.type==='trash');if(!tab||!tab.selected.size)return;
    if(!confirm('Permanently delete '+tab.selected.size+' item(s)? This cannot be undone.'))return;
    const ids=[...tab.selected];
    const r=await trashApi({action:'trash_delete_multi',ids:ids.join(',')});
    if(r.ok){toast((r.deleted||ids.length)+' item(s) deleted','success');tab.selected=new Set();refreshAfterTrashOp()}
    else toast('Delete failed: '+(r.error||''),'error');
}
async function trashEmptyAll(){
    if(!confirm('Empty trash? All items will be permanently deleted. This cannot be undone.'))return;
    const r=await trashApi({action:'trash_empty'});
    if(r.ok){toast('Trash emptied','success');refreshAfterTrashOp()}
    else toast('Empty failed: '+(r.error||''),'error');
}

async function refreshAfterTrashOp(){
    const tab=tabs.find(t=>t.type==='trash');
    if(tab&&activeTab===tab)await loadTrashItems(tab);
    updateTrashDock();
    loadSidebar();
    if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab);
}

async function updateTrashDock(){
    const r=await trashApi({action:'trash_stats'});
    const dock=document.getElementById('trashDock'),cntEl=document.getElementById('trashDockCount'),sizeEl=document.getElementById('trashDockSize');
    if(r.ok){
        trashCount=r.count||0;trashSizeH=r.totalSizeH||'0 B';
        dock.classList.toggle('has-items',trashCount>0);
        cntEl.textContent=trashCount;cntEl.style.display=trashCount>0?'':'none';
        sizeEl.textContent=trashCount>0?trashSizeH:'Empty';
    }
}

function trashDockDragOver(e){e.preventDefault();e.dataTransfer.dropEffect='move';document.getElementById('trashDock').classList.add('drag-hover')}
function trashDockDragLeave(e){document.getElementById('trashDock').classList.remove('drag-hover')}
async function trashDockDrop(e){
    e.preventDefault();e.stopPropagation();
    document.getElementById('trashDock').classList.remove('drag-hover');
    let paths=[];
    try{paths=JSON.parse(e.dataTransfer.getData('text/plain'))}catch(err){}
    if(!paths.length&&browserDraggedPaths.length)paths=browserDraggedPaths;
    if(!paths.length)return;
    await moveItemsToTrash(paths);
    browserDraggedPaths=[];
    loadSidebar();
    if(activeTab&&activeTab.type==='browser')await browserLoadDir(activeTab);
}

document.getElementById('trashSearchInput').addEventListener('input',function(){
    const tab=tabs.find(t=>t.type==='trash');if(!tab)return;
    tab.searchFilter=this.value;
    clearTimeout(tab._searchTimer);
    tab._searchTimer=setTimeout(()=>loadTrashItems(tab),300);
});

// --- COMMAND PALETTE ---
function openPalette(){
    closeModal();
    const commands=[
        {icon:'\u{1F4C2}',label:'Browse Root',shortcut:'',handler:()=>openBrowserTab('')},
        {icon:'\u{1F4C4}',label:'New File',shortcut:'',handler:()=>promptNewFile()},
        {icon:'\u{1F4C1}',label:'New Folder',shortcut:'',handler:()=>promptNewFolder()},
        {icon:'\u{1F517}',label:'New Symlink',shortcut:'',handler:()=>promptCreateSymlink()},
        {icon:'\u{1F4BE}',label:'Save File',shortcut:'Ctrl+S',handler:()=>saveCurrentFile()},
        {icon:'\u{1F4CB}',label:'Copy Selected Files',shortcut:'Ctrl+C',handler:()=>copySelected()},
        {icon:'\u2702\uFE0F',label:'Cut Selected Files',shortcut:'Ctrl+X',handler:()=>cutSelected()},
        {icon:'\u{1F4CB}',label:'Paste Files',shortcut:'Ctrl+V',handler:()=>pasteFiles()},
        {icon:'\u{1F50D}',label:'Find & Replace',shortcut:'Ctrl+F',handler:()=>openFindBar(true)},
        {icon:'\u{1F4CD}',label:'Go to Line',shortcut:'Ctrl+G',handler:()=>{if(editor)editor.execCommand('jumpToLine')}},
        {icon:'\u26A0\uFE0F',label:'Lint Current File',shortcut:'Ctrl+Shift+L',handler:()=>lintCurrentFile()},
        {icon:'\u{1F4AC}',label:'Toggle Comment',shortcut:'Ctrl+/',handler:()=>{if(editor)editor.execCommand('toggleComment')}},
        {icon:'\u{1F5D1}\uFE0F',label:'Open Trash',shortcut:'',handler:()=>openTrashTab()},
        {icon:'\u{1F5D1}\uFE0F',label:'Empty Trash',shortcut:'',handler:()=>trashEmptyAll()},
        {icon:'\u274C',label:'Close Tab',shortcut:'Ctrl+W',handler:()=>{const i=tabs.indexOf(activeTab);if(i>=0)closeTab(i)}},
        {icon:'\u2139\uFE0F',label:'Toggle Info Panel',shortcut:'',handler:()=>{infoPanelVisible=!infoPanelVisible;document.getElementById('infoPanel').classList.toggle('visible',infoPanelVisible)}},
    ];
    let h='<div class="palette-overlay" id="paletteOverlay" onclick="if(event.target===this)closePalette()"><div class="palette"><input type="text" id="paletteInput" placeholder="Type a command..."><div class="palette-results" id="paletteResults">';
    h+=commands.map((c,i)=>'<div class="palette-item" data-idx="'+i+'" onclick="executePaletteCmd('+i+')"><span class="pi-icon">'+c.icon+'</span><span class="pi-label">'+escH(c.label)+'</span>'+(c.shortcut?'<span class="pi-shortcut">'+c.shortcut+'</span>':'')+'</div>').join('');
    h+='</div></div></div>';
    document.body.insertAdjacentHTML('beforeend',h);
    const inp=document.getElementById('paletteInput');inp.focus();
    window._paletteCommands=commands;
    let activeIdx=0;
    inp.addEventListener('input',()=>{
        const q=inp.value.toLowerCase();
        const items=document.querySelectorAll('.palette-item');
        activeIdx=0;let first=true;
        items.forEach((el,i)=>{
            const match=commands[i].label.toLowerCase().includes(q);
            el.style.display=match?'':'none';
            el.classList.toggle('active',match&&first);if(match&&first){activeIdx=i;first=false}else el.classList.remove('active');
        });
    });
    inp.addEventListener('keydown',e=>{
        if(e.key==='Escape')closePalette();
        if(e.key==='Enter'){e.preventDefault();executePaletteCmd(activeIdx)}
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){
            e.preventDefault();
            const items=[...document.querySelectorAll('.palette-item')].filter(el=>el.style.display!=='none');
            const curIdx=items.findIndex(el=>el.classList.contains('active'));
            const next=e.key==='ArrowDown'?Math.min(curIdx+1,items.length-1):Math.max(curIdx-1,0);
            items.forEach((el,i)=>el.classList.toggle('active',i===next));
            activeIdx=parseInt(items[next]?.dataset.idx||'0');
            items[next]?.scrollIntoView({block:'nearest'});
        }
    });
}
function executePaletteCmd(idx){closePalette();if(window._paletteCommands&&window._paletteCommands[idx])window._paletteCommands[idx].handler()}
function closePalette(){const o=document.getElementById('paletteOverlay');if(o)o.remove()}

// --- KEYBOARD SHORTCUTS ---
document.addEventListener('keydown',e=>{
    const inEditor=activeTab&&activeTab.type==='editor';
    const inBrowser=activeTab&&activeTab.type==='browser';

    if((e.ctrlKey||e.metaKey)&&(e.key==='s'||e.key==='u')){e.preventDefault();saveCurrentFile();return}
    if((e.ctrlKey||e.metaKey)&&e.key==='l'&&!e.shiftKey&&!e.altKey){
        // Don't steal Ctrl+L while typing in another input/textarea
        const a=document.activeElement;
        const inField=a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA');
        if(!inField||a.id==='urlBar'){e.preventDefault();urlBarFocus();return}
    }
    if((e.ctrlKey||e.metaKey)&&e.key==='p'){e.preventDefault();openPalette();return}
    if((e.ctrlKey||e.metaKey)&&e.key==='f'&&inEditor){e.preventDefault();openFindBar(false);return}
    if((e.ctrlKey||e.metaKey)&&e.key==='h'&&inEditor){e.preventDefault();openFindBar(true);return}
    if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key==='L'){e.preventDefault();lintCurrentFile();return}
    if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key==='d'){e.preventDefault();downloadCurrentFile();return}
    if((e.ctrlKey||e.metaKey)&&e.key==='w'){e.preventDefault();const i=tabs.indexOf(activeTab);if(i>=0)closeTab(i);return}
    if(e.ctrlKey&&e.key==='Tab'){e.preventDefault();const i=tabs.indexOf(activeTab);if(tabs.length>1){const next=e.shiftKey?(i-1+tabs.length)%tabs.length:(i+1)%tabs.length;switchTab(tabs[next])}return}

    // Copy/Cut/Paste — only in browser with no modal/overlay open
    if(!document.getElementById('modalOverlay')&&!document.getElementById('paletteOverlay')){
        if((e.ctrlKey||e.metaKey)&&e.key==='c'&&inBrowser&&activeTab.selected.size){
            e.preventDefault();copySelected();return;
        }
        if((e.ctrlKey||e.metaKey)&&e.key==='x'&&inBrowser&&activeTab.selected.size){
            e.preventDefault();cutSelected();return;
        }
        if((e.ctrlKey||e.metaKey)&&e.key==='v'&&inBrowser&&clipboard.paths.length){
            e.preventDefault();pasteFiles();return;
        }
    }

    if(e.key==='Delete'&&inBrowser&&activeTab.selected.size){e.preventDefault();browserDeleteSelected();return}
    if(e.key==='Escape'){closePreview();closePalette();closeModal();closeFindBar();closeContextMenu()}
});

// --- CODEMIRROR INIT ---
editor=CodeMirror(document.getElementById('editorCm'),{
    theme:'material-darker',
    lineNumbers:true,lineWrapping:false,
    matchBrackets:true,autoCloseBrackets:true,autoCloseTags:true,matchTags:{bothTags:true},
    foldGutter:true,gutters:['CodeMirror-linenumbers','CodeMirror-foldgutter','lint-gutter'],
    styleActiveLine:true,indentUnit:4,tabSize:4,indentWithTabs:false,
    extraKeys:{
        'Tab':cm=>{if(cm.somethingSelected())cm.indentSelection('add');else cm.replaceSelection('    ','end')},
        'Shift-Tab':cm=>cm.indentSelection('subtract'),
        'Ctrl-/':'toggleComment',
        'Cmd-/':'toggleComment',
        'Alt-Up':cm=>{const cur=cm.getCursor();if(cur.line===0)return;const line=cm.getLine(cur.line);cm.replaceRange('',{line:cur.line-1,ch:cm.getLine(cur.line-1).length},{line:cur.line,ch:line.length});cm.replaceRange('\n'+cm.getLine(cur.line-1),{line:cur.line-1,ch:0},{line:cur.line-1,ch:cm.getLine(cur.line-1).length});cm.setCursor(cur.line-1,cur.ch)},
        'Alt-Down':cm=>{const cur=cm.getCursor();if(cur.line>=cm.lineCount()-1)return;const line=cm.getLine(cur.line);const next=cm.getLine(cur.line+1);cm.replaceRange(next+'\n'+line,{line:cur.line,ch:0},{line:cur.line+1,ch:next.length});cm.setCursor(cur.line+1,cur.ch)},
        'Ctrl-Space':'autocomplete',
    }
});
editor.on('changes',()=>{if(activeTab&&activeTab.type==='editor'){activeTab.modified=true;renderTabs();minimapDirty=true;clearTimeout(lintDebounceTimer);lintDebounceTimer=setTimeout(()=>autoLint(activeTab),1200)}});
editor.on('cursorActivity',()=>updateStatusBar());
editor.on('scroll',()=>updateMinimapViewport());
editor.getWrapperElement().style.display='none';

// --- INIT ---
async function init(){
    // URL bar event handlers
    const urlInp=document.getElementById('urlBar');
    if(urlInp){
        urlInp.addEventListener('keydown',e=>{
            if(e.key==='Enter'){e.preventDefault();urlBarNavigate()}
            else if(e.key==='Escape'){e.preventDefault();urlInp.blur();updateUrlBar()}
        });
        urlInp.addEventListener('focus',()=>{setTimeout(()=>urlInp.select(),0)});
    }
    updateUrlBar();

    renderFavorites();
    await loadSidebar();
    updateTrashDock();
    updateClipboardUI();

    const params=new URLSearchParams(location.search);
    const tabsParam=params.get('tabs');
    const activeParam=parseInt(params.get('active')||'0');
    if(tabsParam){
        const parts=tabsParam.split('|');
        for(const p of parts){
            if(p.startsWith('e:')){await openEditorTab(p.substring(2))}
            else if(p.startsWith('t:')){openTrashTab()}
            else if(p.startsWith('b:')){openBrowserTab(p.substring(2))}
        }
        if(tabs[activeParam])switchTab(tabs[activeParam]);
    }else{
        const file=params.get('file'),dir=params.get('dir');
        if(file)await openEditorTab(file);
        else if(dir)openBrowserTab(dir);
    }
}
init();
</script>
</body>
</html>
