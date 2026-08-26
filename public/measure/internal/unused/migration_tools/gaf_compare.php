<?php
require_once __DIR__ . '/_storage.php';
/**
 * gaf_compare.php
 *
 * Tabs: COMPARE | PENDING
 *
 * Compare tab features:
 *   - Side-by-side GAF vs project PDF
 *   - Gemini measurement analysis with discrepancy score/percentage
 *   - Batch analysis: run Gemini on all GAF-available projects at once
 *   - Results cached in gaf_compare_cache/ (separate from gaf_index.json)
 *   - Sort by discrepancy score, toggle hide no-GAF items
 *   - Sort/toggle state persisted via localStorage
 *
 * Pending tab features:
 *   - Scan addresses.json for GAF availability
 *   - Persistent index in gaf_index.json (resumable)
 *   - Save snapshot of pending+GAF addresses
 */

$compareCacheDir = __DIR__ . '/gaf_compare_cache/';
$indexPath       = storageExistingPath('data/gaf_index.json', __DIR__ . '/gaf_index.json', true);
$addressesFile   = storageExistingPath('data/addresses.json', __DIR__ . '/addresses.json', true);
$savesDir        = __DIR__ . '/saves/';
$gafFetchUrl     = 'https://apexroofingnw.com/internal/app/gaf_fetch.php';
$geminiKey       = 'REMOVED_CREDENTIAL';
$geminiModel     = 'gemini-3.1-pro-preview';

if (!file_exists($compareCacheDir)) @mkdir($compareCacheDir, 0777, true);

// ── POST handlers ───────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    header('Content-Type: application/json');
    $act = $_POST['_action'] ?? '';

    // ── Read all compare cache entries ──────────
    if ($act === 'read_compare_cache') {
        $cache = [];
        foreach (glob($compareCacheDir . '*.json') as $f) {
            $key = basename($f, '.json');
            $d = json_decode(@file_get_contents($f), true);
            if (is_array($d)) $cache[$key] = $d;
        }
        echo json_encode(['ok' => true, 'cache' => $cache]);
        exit;
    }

    // ── Write a single compare cache entry ──────
    if ($act === 'write_compare_cache') {
        $folder = $_POST['folder'] ?? '';
        $data   = json_decode($_POST['data'] ?? '{}', true);
        if (!$folder || !is_array($data)) {
            echo json_encode(['ok' => false, 'error' => 'Invalid params']);
            exit;
        }
        $file = $compareCacheDir . preg_replace('/[^a-f0-9]/', '', $folder) . '.json';
        $ok = @file_put_contents($file, json_encode($data, JSON_PRETTY_PRINT));
        echo json_encode(['ok' => (bool)$ok]);
        exit;
    }

    // ── Gemini analysis ─────────────────────────
    if ($act === 'analyze') {
        $gaf_url        = $_POST['gaf_url'] ?? '';
        $project_folder = $_POST['project_folder'] ?? '';

        if (!$gaf_url || !$project_folder) {
            echo json_encode(['ok' => false, 'error' => 'Missing gaf_url or project_folder']);
            exit;
        }

        $localPdf = $savesDir . basename($project_folder) . '/Report.pdf';
        if (!file_exists($localPdf)) {
            echo json_encode(['ok' => false, 'error' => 'Local Report.pdf not found']);
            exit;
        }

        $ch = curl_init($gaf_url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_FOLLOWLOCATION=>true, CURLOPT_TIMEOUT=>30, CURLOPT_SSL_VERIFYPEER=>false]);
        $gafData = curl_exec($ch); $gafCode = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);

        if ($gafCode !== 200 || !$gafData) {
            echo json_encode(['ok' => false, 'error' => 'Failed to fetch GAF PDF (HTTP ' . $gafCode . ')']);
            exit;
        }

        $projData = file_get_contents($localPdf);
        $gafB64   = base64_encode($gafData);
        $projB64  = base64_encode($projData);

        $geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' . $geminiModel . ':generateContent?key=' . $geminiKey;

        $prompt = <<<'PROMPT'
You are a roofing measurement auditor. I'm giving you two PDF reports for the same property.

**PDF 1 (GAF Report):** The official GAF aerial measurement report.
**PDF 2 (Project Report):** Our internal measurement report.

Respond with ONLY valid JSON — no markdown fences, no commentary, no text before or after. Just raw JSON.

Both reports may contain multiple structures (e.g. "Main Roof", "Garage", "Detached Garage", "Shed", etc.). Compare them structure-by-structure.

Return this exact JSON schema:

{
  "overall_discrepancy_score": <number 0-100, 0=identical 100=completely different>,
  "overall_discrepancy_pct": <number, average % difference across all measurements>,
  "summary": "<1-3 sentence plain text summary of the biggest differences>",
  "structures": [
    {
      "name": "<structure name, e.g. 'Main Roof', 'Garage'>",
      "in_gaf": true,
      "in_project": true,
      "measurements": {
        "roof_area": {
          "gaf": <number or null if not found>,
          "project": <number or null>,
          "unit": "sqft",
          "diff_pct": <number or null>,
          "flag": <true if diff > 5%, false otherwise>
        },
        "roof_facets": {
          "gaf": <number or null>,
          "project": <number or null>,
          "unit": "count",
          "diff_pct": <number or null>,
          "flag": <boolean>
        },
        "predominant_pitch": {
          "gaf": "<string like '6/12' or null>",
          "project": "<string or null>",
          "unit": "pitch",
          "diff_pct": null,
          "flag": <true if they don't match>
        },
        "ridges_hips": {
          "gaf": <number or null>,
          "project": <number or null>,
          "unit": "ft",
          "diff_pct": <number or null>,
          "flag": <boolean>
        },
        "valleys": {
          "gaf": <number or null>,
          "project": <number or null>,
          "unit": "ft",
          "diff_pct": <number or null>,
          "flag": <boolean>
        },
        "rakes": {
          "gaf": <number or null>,
          "project": <number or null>,
          "unit": "ft",
          "diff_pct": <number or null>,
          "flag": <boolean>
        },
        "eaves": {
          "gaf": <number or null>,
          "project": <number or null>,
          "unit": "ft",
          "diff_pct": <number or null>,
          "flag": <boolean>
        },
        "skylights": {
          "gaf": <number or null>,
          "project": <number or null>,
          "unit": "count",
          "diff_pct": <number or null>,
          "flag": <boolean>
        }
      }
    }
  ],
  "missing_structures": [
    {
      "name": "<structure name>",
      "present_in": "<'gaf' or 'project'>",
      "missing_from": "<'gaf' or 'project'>"
    }
  ],
  "notes": "<any additional observations, e.g. waste factor differences, order quantity differences, anything else notable>"
}

Rules:
- diff_pct = abs((gaf - project) / ((gaf + project) / 2)) * 100, rounded to 1 decimal
- If a value is not found in one report, set it to null and diff_pct to null, flag to true
- If the report only has one structure (most common), still return it as a single-item array
- Combine ridges and hips into one "ridges_hips" total
- For predominant_pitch, just compare the string values; flag=true if they differ
- overall_discrepancy_pct should be the average of all non-null diff_pct values across all structures
- overall_discrepancy_score: 0-10 = nearly identical, 10-25 = minor differences, 25-50 = moderate, 50+ = major
PROMPT;

        $payload = [
            'contents' => [['parts' => [
                ['inline_data' => ['mime_type' => 'application/pdf', 'data' => $gafB64]],
                ['inline_data' => ['mime_type' => 'application/pdf', 'data' => $projB64]],
                ['text' => $prompt],
            ]]],
            'generationConfig' => ['temperature' => 0.1, 'maxOutputTokens' => 8192],
        ];

        $ch = curl_init($geminiUrl);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER=>true, CURLOPT_POST=>true,
            CURLOPT_HTTPHEADER=>['Content-Type: application/json'],
            CURLOPT_POSTFIELDS=>json_encode($payload), CURLOPT_TIMEOUT=>120, CURLOPT_SSL_VERIFYPEER=>false,
        ]);
        $resp = curl_exec($ch); $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE); $curlErr = curl_error($ch); curl_close($ch);

        if ($curlErr) { echo json_encode(['ok'=>false,'error'=>'Curl: '.$curlErr]); exit; }

        $result = json_decode($resp, true);
        if ($httpCode !== 200) {
            $errMsg = $result['error']['message'] ?? ('HTTP '.$httpCode.': '.substr($resp,0,300));
            echo json_encode(['ok'=>false,'error'=>$errMsg]); exit;
        }

        $text = $result['candidates'][0]['content']['parts'][0]['text'] ?? '';
        if (!$text) { echo json_encode(['ok'=>false,'error'=>'Empty Gemini response','raw'=>substr($resp,0,500)]); exit; }

        // Strip markdown fences if present
        $text = preg_replace('/^```(?:json)?\s*/m', '', $text);
        $text = preg_replace('/\s*```\s*$/m', '', $text);
        $text = trim($text);

        $parsed = json_decode($text, true);
        if (!is_array($parsed)) {
            echo json_encode(['ok'=>false,'error'=>'Gemini did not return valid JSON','raw'=>substr($text,0,800)]);
            exit;
        }

        echo json_encode([
            'ok' => true,
            'data' => $parsed,
            'discrepancy_score' => $parsed['overall_discrepancy_score'] ?? null,
            'discrepancy_pct' => $parsed['overall_discrepancy_pct'] ?? null,
        ]);
        exit;
    }

    // ── Pending: read index ─────────────────────
    if ($act === 'read_index') {
        $data = file_exists($indexPath) ? json_decode(@file_get_contents($indexPath), true) : [];
        echo json_encode(['ok'=>true,'index'=>is_array($data)?$data:[]]);
        exit;
    }
    if ($act === 'update_index') {
        $batch = json_decode($_POST['batch'] ?? '{}', true);
        if (!is_array($batch) || empty($batch)) { echo json_encode(['ok'=>false]); exit; }
        $lf = fopen($indexPath.'.lock','c+'); if ($lf) flock($lf,LOCK_EX);
        $ex = file_exists($indexPath) ? json_decode(@file_get_contents($indexPath),true) : [];
        if (!is_array($ex)) $ex = [];
        foreach ($batch as $a=>$e) $ex[$a] = $e;
        @file_put_contents($indexPath, json_encode($ex, JSON_PRETTY_PRINT));
        if ($lf) { flock($lf,LOCK_UN); fclose($lf); }
        echo json_encode(['ok'=>true,'total'=>count($ex)]); exit;
    }
    if ($act === 'clear_index') {
        @file_put_contents($indexPath, '{}');
        echo json_encode(['ok'=>true]); exit;
    }
    if ($act === 'save_snapshot') {
        $payload = json_decode($_POST['data'] ?? '[]', true);
        if (!is_array($payload) || empty($payload)) { echo json_encode(['ok'=>false,'error'=>'No data']); exit; }
        $sd = __DIR__.'/gaf_snapshots/'; if (!file_exists($sd)) @mkdir($sd,0777,true);
        $f = $sd.'pending_gaf_'.date('Y-m-d_H-i-s').'.json';
        // Just save a flat array of address strings
        $addrs = array_map(fn($item) => is_array($item) ? ($item['address'] ?? '') : $item, $payload);
        $addrs = array_values(array_filter($addrs));
        $ok = @file_put_contents($f, json_encode($addrs, JSON_PRETTY_PRINT));
        echo json_encode(['ok'=>(bool)$ok,'file'=>basename($f),'count'=>count($addrs)]); exit;
    }
}

// ── Load data ───────────────────────────────────────────────────────
$addresses = [];
if (file_exists($addressesFile)) {
    $raw = json_decode(file_get_contents($addressesFile), true);
    if (is_array($raw)) $addresses = $raw;
}
$gafIndex = file_exists($indexPath) ? json_decode(@file_get_contents($indexPath), true) : [];
if (!is_array($gafIndex)) $gafIndex = [];

// Load compare cache
$compareCache = [];
foreach (glob($compareCacheDir . '*.json') as $f) {
    $key = basename($f, '.json');
    $d = json_decode(@file_get_contents($f), true);
    if (is_array($d)) $compareCache[$key] = $d;
}

function getFolder($address) { return md5(strtolower(trim($address))); }

$projects = [];
$pending  = [];

foreach ($addresses as $addr) {
    if (!is_string($addr) || trim($addr) === '') continue;
    $folder = getFolder($addr);
    $targetDir = $savesDir . $folder . '/';
    $mp = $targetDir . 'manifest.json';

    if (file_exists($mp)) {
        $m = json_decode(@file_get_contents($mp), true);
        if (!is_array($m)) $m = [];
        $status    = strtolower($m['status'] ?? '');
        $hasReport = file_exists($targetDir . 'Report.pdf');

        if ($status === 'completed' && $hasReport) {
            $cc = $compareCache[$folder] ?? null;
            $reportDate = '';
            $rpf = $targetDir . 'Report.pdf';
            if (file_exists($rpf)) {
                $reportDate = date('c', filemtime($rpf));
            }
            $projects[] = [
                'address'     => $m['address'] ?? $addr,
                'folder'      => $folder,
                'completed'   => $m['completed_at'] ?? '',
                'report_date' => $reportDate,
                'has_gaf'     => $cc ? ($cc['has_gaf'] ?? false) : null,
                'gaf_url'     => $cc['gaf_url'] ?? null,
                'score'       => $cc['discrepancy_score'] ?? null,
                'pct'         => $cc['discrepancy_pct'] ?? null,
                'analyzed'    => !empty($cc['data']) || !empty($cc['analysis']),
            ];
            continue;
        }
        $pending[] = ['address' => $m['address'] ?? $addr, 'status' => $status];
    } else {
        $pending[] = ['address' => $addr, 'status' => 'none'];
    }
}

usort($projects, fn($a,$b) => strcmp($b['completed'], $a['completed']));
usort($pending, fn($a,$b) => strcasecmp($a['address'], $b['address']));

$projectCount = count($projects);
$pendingCount = count($pending);
$pendingIndexed = 0; $pendingWithGaf = 0;
foreach ($pending as $p) {
    if (isset($gafIndex[$p['address']])) { $pendingIndexed++; if (!empty($gafIndex[$p['address']]['has_gaf'])) $pendingWithGaf++; }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GAF Report Comparison</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--sidebar-w:310px;--bg:#0f1117;--sidebar-bg:#171a23;--panel-bg:#1c1f2b;--border:#2a2d3a;--text:#d4d6de;--text-dim:#8a8d9b;--accent:#4e8cff;--green:#34d399;--red:#f87171;--yellow:#facc15;--hover:#22253a;--active:#272b40;--purple:#8b5cf6}
html,body{height:100%;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text)}
.layout{display:flex;height:100vh}

/* Sidebar */
.sidebar{width:var(--sidebar-w);min-width:var(--sidebar-w);background:var(--sidebar-bg);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.tab-bar{display:flex;flex-shrink:0;border-bottom:1px solid var(--border)}
.tab-btn{flex:1;padding:10px 0;text-align:center;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);background:none;border:none;cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}
.tab-btn:hover{color:var(--text);background:var(--hover)}
.tab-btn.active{color:var(--accent);border-bottom-color:var(--accent)}
.tab-btn .tc{display:inline-block;min-width:18px;padding:1px 5px;border-radius:8px;font-size:9px;font-weight:700;margin-left:4px;background:var(--border);color:var(--text-dim)}
.tab-btn.active .tc{background:rgba(78,140,255,.2);color:var(--accent)}

.tab-content{display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0}
.tab-content.active{display:flex}

/* Controls bar */
.controls{padding:6px 10px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;gap:5px}
.controls-row{display:flex;align-items:center;gap:6px}
.controls input[type=text]{flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;outline:none}
.controls input:focus{border-color:var(--accent)}
.controls input::placeholder{color:var(--text-dim)}
.controls select{padding:5px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:10px;outline:none;cursor:pointer}
.controls select:focus{border-color:var(--accent)}
.toggle-label{font-size:10px;color:var(--text-dim);display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;white-space:nowrap}
.toggle-label input{accent-color:var(--accent);cursor:pointer}

.item-list{flex:1;overflow-y:auto;padding:4px 0}
.item-list::-webkit-scrollbar{width:5px}
.item-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}

.project-item,.pending-item{padding:9px 14px;cursor:pointer;border-left:3px solid transparent;transition:all .12s}
.project-item:hover,.pending-item:hover{background:var(--hover)}
.project-item.active{background:var(--active);border-left-color:var(--accent)}
.project-item.no-gaf-hidden{display:none}

.addr-row{display:flex;align-items:flex-start;gap:6px}
.addr-row .addr{flex:1;font-size:12px;font-weight:600;color:#e2e4ec;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}

.copy-btn{flex-shrink:0;width:24px;height:24px;border:none;border-radius:5px;background:transparent;color:var(--text-dim);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .12s}
.copy-btn:hover{background:rgba(255,255,255,.08);color:#fff}
.copy-btn.copied{color:var(--green)}
.copy-btn svg{width:13px;height:13px}

.meta{font-size:10px;color:var(--text-dim);margin-top:2px}
.badges{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap}
.badge{font-size:9px;font-weight:600;padding:2px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em}
.badge.gaf-loading{background:#332e00;color:var(--yellow)}
.badge.gaf-found{background:#0d3320;color:var(--green)}
.badge.gaf-none{background:#331515;color:var(--red)}
.badge.gaf-cached{background:#1a2733;color:#67b8e3}
.badge.pdf{background:#1a1a33;color:#a78bfa}
.badge.status-none{background:#1a1a33;color:var(--text-dim)}
.badge.status-wip{background:#332e00;color:var(--yellow)}
.badge.score{background:#1f1533;color:var(--purple);font-variant-numeric:tabular-nums}
.badge.score.high{background:#331515;color:var(--red)}
.badge.score.med{background:#332e00;color:var(--yellow)}
.badge.score.low{background:#0d3320;color:var(--green)}
.badge.analyzed{background:#1a1033;color:#a78bfa}

.empty-sidebar{padding:30px 16px;text-align:center;color:var(--text-dim);font-size:12px;line-height:1.6}

/* Batch button in compare controls */
.batch-btn{padding:5px 10px;border:none;border-radius:5px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em;transition:all .12s}
.batch-btn:hover{background:linear-gradient(135deg,#7c3aed,#5b21b6)}
.batch-btn:disabled{opacity:.4;cursor:not-allowed}

/* Pending actions */
.pending-actions{flex-shrink:0;padding:10px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:6px}
.pending-actions .row{display:flex;gap:6px}
.pending-actions .row>*{flex:1}
.scan-btn,.save-btn,.clear-btn{width:100%;padding:8px 12px;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:.04em;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:6px}
.scan-btn{background:var(--accent);color:#fff}
.scan-btn:hover{background:#3d7ae6}
.scan-btn:disabled{opacity:.5;cursor:not-allowed}
.save-btn{background:var(--green);color:#0d3320}
.save-btn:hover{background:#2bc48a}
.save-btn:disabled{opacity:.3;cursor:not-allowed}
.clear-btn{background:#332;color:var(--text-dim);font-size:10px}
.clear-btn:hover{background:#443;color:var(--yellow)}
.pending-status{font-size:10px;color:var(--text-dim);text-align:center;min-height:16px;line-height:1.4}
.progress-bar{height:3px;background:var(--border);border-radius:2px;overflow:hidden;margin-top:4px}
.progress-bar .fill{height:100%;background:var(--accent);transition:width .2s;width:0%}

/* Main panels */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.panels{flex:1;display:flex;flex-direction:row;min-height:0}
.panel{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.panel-header{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--panel-bg);border-bottom:1px solid var(--border);flex-shrink:0;min-height:36px}
.panel-header .label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)}
.panel-header .label .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}
.panel-header .label .dot.gaf{background:var(--yellow)}
.panel-header .label .dot.proj{background:#a78bfa}
.panel-header a{font-size:10px;color:var(--accent);text-decoration:none}
.panel-header a:hover{text-decoration:underline}
.panel-body{flex:1;min-height:0;background:#111319}
.panel-body iframe{width:100%;height:100%;border:none}
.placeholder{display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-dim);font-size:13px;text-align:center;padding:20px;line-height:1.6}
.placeholder .icon{font-size:32px;margin-bottom:10px;opacity:.4}
.placeholder .err-detail{font-size:11px;color:var(--red);margin-top:8px;word-break:break-all;max-width:90%;opacity:.8}
.spinner{width:22px;height:22px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 10px}
.spinner-inline{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.divider{width:5px;cursor:col-resize;background:var(--border);flex-shrink:0;transition:background .15s;z-index:2}
.divider:hover,.divider.dragging{background:var(--accent)}
.pending-item.has-gaf{border-left-color:var(--green)}

/* Analysis module */
.analysis-module{border-top:1px solid var(--border);background:var(--sidebar-bg);flex-shrink:0;overflow:hidden}
.analysis-toggle{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;cursor:pointer;user-select:none;transition:background .12s}
.analysis-toggle:hover{background:var(--hover)}
.analysis-toggle .label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);display:flex;align-items:center;gap:8px}
.analysis-toggle .label .gem-dot{width:8px;height:8px;border-radius:50%;background:var(--purple)}
.analysis-toggle .chevron{color:var(--text-dim);font-size:14px;transition:transform .2s}
.analysis-toggle .chevron.open{transform:rotate(180deg)}
.analysis-body{padding:0 16px 16px}
.analysis-body.collapsed{display:none}
.analyze-btn{padding:10px 20px;border:none;border-radius:6px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center;gap:8px}
.analyze-btn:hover{background:linear-gradient(135deg,#7c3aed,#5b21b6);transform:translateY(-1px)}
.analyze-btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
.analysis-status{font-size:11px;color:var(--text-dim);margin-top:8px}
.analysis-scores{display:flex;gap:12px;margin-top:10px}
.score-card{padding:10px 16px;border-radius:8px;background:var(--bg);border:1px solid var(--border);text-align:center;flex:1}
.score-card .val{font-size:24px;font-weight:800;font-variant-numeric:tabular-nums}
.score-card .lbl{font-size:9px;text-transform:uppercase;color:var(--text-dim);margin-top:2px;letter-spacing:.05em}
.score-card.low .val{color:var(--green)}
.score-card.med .val{color:var(--yellow)}
.score-card.high .val{color:var(--red)}
.analysis-result{margin-top:12px;padding:16px;border-radius:8px;background:var(--bg);border:1px solid var(--border);font-size:12px;line-height:1.7;color:var(--text);max-height:500px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.analysis-result::-webkit-scrollbar{width:5px}
.analysis-result::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.analysis-result h1,.analysis-result h2,.analysis-result h3{color:#fff;margin:12px 0 6px}
.analysis-result h1{font-size:16px} .analysis-result h2{font-size:14px} .analysis-result h3{font-size:12px}
.analysis-result table{border-collapse:collapse;width:100%;margin:10px 0;font-size:11px}
.analysis-result th,.analysis-result td{padding:6px 10px;border:1px solid var(--border);text-align:left}
.analysis-result th{background:var(--panel-bg);color:#fff;font-weight:700}
.analysis-result code{background:var(--panel-bg);padding:1px 5px;border-radius:3px;font-size:11px}
.analysis-result strong{color:#fff}

/* Structured analysis */
.analysis-summary{padding:10px 14px;background:var(--panel-bg);border-radius:6px;margin-bottom:12px;font-size:12px;line-height:1.6;color:var(--text)}
.missing-warn{padding:10px 14px;background:#2a1515;border:1px solid #4a2020;border-radius:6px;margin-bottom:12px;font-size:11px;line-height:1.6;color:var(--red)}
.struct-block{margin-bottom:16px}
.struct-header{font-size:13px;padding:6px 0;margin-bottom:4px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.struct-table{border-collapse:collapse;width:100%;font-size:11px}
.struct-table th{padding:6px 10px;border:1px solid var(--border);background:var(--panel-bg);color:var(--text-dim);font-weight:700;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
.struct-table td{padding:6px 10px;border:1px solid var(--border);text-align:left}
.struct-table tr.flagged-row{background:rgba(248,113,113,.06)}
.struct-table tr.flagged-row td{border-color:#3a2020}
.d-badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
.d-badge.d-low{background:#0d3320;color:var(--green)}
.d-badge.d-med{background:#332e00;color:var(--yellow)}
.d-badge.d-high{background:#331515;color:var(--red)}
.d-badge.d-miss{background:#2a1515;color:var(--red)}
.d-badge.d-na{background:var(--panel-bg);color:var(--text-dim)}
.analysis-notes{padding:10px 14px;background:var(--panel-bg);border-radius:6px;margin-top:12px;font-size:11px;line-height:1.6;color:var(--text-dim)}
</style>
</head>
<body>
<div class="layout">
    <div class="sidebar">
        <div class="tab-bar">
            <button class="tab-btn active" onclick="switchTab('compare')">Compare <span class="tc"><?=$projectCount?></span></button>
            <button class="tab-btn" onclick="switchTab('pending')">Pending <span class="tc"><?=$pendingCount?></span></button>
        </div>

        <!-- ═══ COMPARE TAB ═══ -->
        <div class="tab-content active" id="tab-compare">
            <div class="controls">
                <div class="controls-row">
                    <input type="text" id="searchCompare" placeholder="Filter…">
                    <select id="sortSelect" onchange="applySort()">
                        <option value="default">Date ↓</option>
                        <option value="score_desc">Discrepancy ↓</option>
                        <option value="score_asc">Discrepancy ↑</option>
                    </select>
                </div>
                <div class="controls-row">
                    <label class="toggle-label"><input type="checkbox" id="hideNoGaf" onchange="applyFilter()"> Hide no-GAF</label>
                    <button class="batch-btn" id="batchBtn" onclick="batchAnalyze()">⚡ Batch Analyze</button>
                </div>
            </div>
            <div class="item-list" id="compareList">
                <?php if (empty($projects)): ?>
                    <div class="empty-sidebar">No completed projects found.</div>
                <?php else: ?>
                    <?php foreach ($projects as $p):
                        $sc = $p['score']; $pct = $p['pct'];
                        $scoreClass = $sc === null ? '' : ($sc >= 40 ? 'high' : ($sc >= 15 ? 'med' : 'low'));
                    ?>
                        <div class="project-item"
                             data-folder="<?=htmlspecialchars($p['folder'])?>"
                             data-address="<?=htmlspecialchars($p['address'])?>"
                             data-search="<?=htmlspecialchars(strtolower($p['address']))?>"
                             data-completed="<?=htmlspecialchars($p['completed'])?>"
                             data-has-gaf="<?=$p['has_gaf']===null?'unknown':($p['has_gaf']?'yes':'no')?>"
                             data-gaf-url="<?=htmlspecialchars($p['gaf_url']??'')?>"
                             data-score="<?=$sc!==null?$sc:'none'?>"
                             data-pct="<?=$pct!==null?$pct:'none'?>"
                             data-analyzed="<?=$p['analyzed']?'yes':'no'?>"
                             onclick="selectProject(this)">
                            <div class="addr-row">
                                <div class="addr" title="<?=htmlspecialchars($p['address'])?>"><?=htmlspecialchars($p['address'])?></div>
                                <button class="copy-btn" onclick="event.stopPropagation();copyAddr(this)" data-addr="<?=htmlspecialchars($p['address'])?>" title="Copy">
                                    <svg class="icon-copy" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1.5 1.5 0 00-1.5-1.5H3.5A1.5 1.5 0 002 3.5V9a1.5 1.5 0 001.5 1.5h2"/></svg>
                                    <svg class="icon-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><polyline points="3 8.5 6.5 12 13 4"/></svg>
                                </button>
                            </div>
                            <div class="meta">
                                <?php if($p['report_date']):?>Our report: <?=date('M j, Y',strtotime($p['report_date']))?><?php endif;?>
                                <?php if($p['completed']&&$p['report_date']):?> · <?php endif;?>
                                <?php if($p['completed']):?>Completed: <?=date('M j, Y',strtotime($p['completed']))?><?php endif;?>
                            </div>
                            <div class="badges">
                                <span class="badge pdf">PDF</span>
                                <?php if ($p['has_gaf']===true): ?>
                                    <span class="badge gaf-found gaf-badge">GAF ✓</span>
                                <?php elseif ($p['has_gaf']===false): ?>
                                    <span class="badge gaf-none gaf-badge">No GAF</span>
                                <?php else: ?>
                                    <span class="badge gaf-loading gaf-badge">checking…</span>
                                <?php endif; ?>
                                <?php if ($sc !== null): ?>
                                    <span class="badge score <?=$scoreClass?>"><?=number_format($pct,1)?>%</span>
                                <?php endif; ?>
                                <?php if ($p['analyzed']): ?>
                                    <span class="badge analyzed">analyzed</span>
                                <?php endif; ?>
                            </div>
                        </div>
                    <?php endforeach; ?>
                <?php endif; ?>
            </div>
        </div>

        <!-- ═══ PENDING TAB ═══ -->
        <div class="tab-content" id="tab-pending">
            <div class="controls">
                <input type="text" id="searchPending" placeholder="Filter pending…" style="width:100%">
            </div>
            <div class="item-list" id="pendingList">
                <?php if (empty($pending)): ?>
                    <div class="empty-sidebar">All addresses have completed projects.</div>
                <?php else: ?>
                    <?php foreach ($pending as $p):
                        $cached=$gafIndex[$p['address']]??null;
                        $gs='unknown';$bc='gaf-loading';$bt='—';$hc='';
                        if($cached!==null){if(!empty($cached['has_gaf'])){$gs='found';$bc='gaf-found';$bt='GAF ✓';$hc=' has-gaf';}else{$gs='none';$bc='gaf-none';$bt='No GAF';}}
                    ?>
                        <div class="pending-item<?=$hc?>" data-address="<?=htmlspecialchars($p['address'])?>" data-status="<?=htmlspecialchars($p['status'])?>" data-search="<?=htmlspecialchars(strtolower($p['address']))?>" data-gaf="<?=$gs?>">
                            <div class="addr-row">
                                <div class="addr"><?=htmlspecialchars($p['address'])?></div>
                                <button class="copy-btn" onclick="event.stopPropagation();copyAddr(this)" data-addr="<?=htmlspecialchars($p['address'])?>" title="Copy">
                                    <svg class="icon-copy" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1.5 1.5 0 00-1.5-1.5H3.5A1.5 1.5 0 002 3.5V9a1.5 1.5 0 001.5 1.5h2"/></svg>
                                    <svg class="icon-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><polyline points="3 8.5 6.5 12 13 4"/></svg>
                                </button>
                            </div>
                            <div class="meta">Project: <?=$p['status']==='none'?'not started':htmlspecialchars($p['status'])?></div>
                            <div class="badges">
                                <?php if($p['status']==='none'):?><span class="badge status-none">No project</span><?php else:?><span class="badge status-wip"><?=htmlspecialchars($p['status'])?></span><?php endif;?>
                                <span class="badge <?=$bc?> pending-gaf-badge"><?=$bt?></span>
                                <?php if($cached!==null):?><span class="badge gaf-cached">cached</span><?php endif;?>
                            </div>
                        </div>
                    <?php endforeach;?>
                <?php endif;?>
            </div>
            <div class="pending-actions">
                <div class="pending-status" id="pendingStatus"><?php if($pendingIndexed>0) echo $pendingIndexed.'/'.$pendingCount.' cached • '.$pendingWithGaf.' with GAF';?></div>
                <div class="progress-bar" id="progressBar" style="display:none"><div class="fill" id="progressFill"></div></div>
                <div class="row">
                    <button class="scan-btn" id="scanBtn" onclick="scanPending()"><?=($pendingIndexed>=$pendingCount&&$pendingCount>0)?'All Scanned ✓':($pendingIndexed>0?'Resume Scan':'Scan for GAF')?></button>
                    <button class="save-btn" id="saveBtn" onclick="saveSnapshot()" <?=$pendingWithGaf>0?'':'disabled'?>>Save Snapshot</button>
                </div>
                <button class="clear-btn" onclick="clearIndex()">Clear cache &amp; re-scan</button>
            </div>
        </div>
    </div>

    <!-- Main area -->
    <div class="main">
        <div class="panels" id="panels">
            <div class="panel" id="gafPanel">
                <div class="panel-header">
                    <span class="label"><span class="dot gaf"></span>GAF Report</span>
                    <a href="#" id="gafLink" target="_blank" style="display:none;">Open ↗</a>
                </div>
                <div class="panel-body" id="gafBody">
                    <div class="placeholder"><div><div class="icon">📋</div>Select a project to load the GAF report</div></div>
                </div>
            </div>
            <div class="divider" id="divider"></div>
            <div class="panel" id="projPanel">
                <div class="panel-header">
                    <span class="label"><span class="dot proj"></span>Project Report</span>
                    <a href="#" id="projLink" target="_blank" style="display:none;">Open ↗</a>
                </div>
                <div class="panel-body" id="projBody">
                    <div class="placeholder"><div><div class="icon">📄</div>Select a project to load the completed report</div></div>
                </div>
            </div>
        </div>
        <!-- Analysis module -->
        <div class="analysis-module" id="analysisModule">
            <div class="analysis-toggle" onclick="toggleAnalysis()">
                <span class="label"><span class="gem-dot"></span>Gemini Measurement Analysis</span>
                <span class="chevron" id="analysisChevron">▼</span>
            </div>
            <div class="analysis-body collapsed" id="analysisBody">
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                    <button class="analyze-btn" id="analyzeBtn" onclick="runAnalysis()" disabled>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                        Compare Measurements
                    </button>
                    <span class="analysis-status" id="analysisStatus">Load both reports to enable</span>
                </div>
                <div class="analysis-scores" id="analysisScores" style="display:none">
                    <div class="score-card" id="scoreCard"><div class="val" id="scoreVal">—</div><div class="lbl">Discrepancy Score</div></div>
                    <div class="score-card" id="pctCard"><div class="val" id="pctVal">—</div><div class="lbl">Avg % Difference</div></div>
                </div>
                <div class="analysis-result" id="analysisResult" style="display:none;"></div>
            </div>
        </div>
    </div>
</div>

<script>
const GAF_FETCH_URL = <?=json_encode($gafFetchUrl)?>;
const SELF_URL = window.location.pathname;
const LS_SORT = 'gaf_compare_sort';
const LS_HIDE = 'gaf_compare_hide_nogaf';

// ── Tabs ────────────────────────────────────────
function switchTab(n){
    document.querySelectorAll('.tab-btn').forEach((b,i)=>b.classList.toggle('active',(i===0&&n==='compare')||(i===1&&n==='pending')));
    document.getElementById('tab-compare').classList.toggle('active',n==='compare');
    document.getElementById('tab-pending').classList.toggle('active',n==='pending');
}

// ── Search ──────────────────────────────────────
document.getElementById('searchCompare').addEventListener('input',function(){const q=this.value.toLowerCase();document.querySelectorAll('#compareList .project-item').forEach(el=>el.style.display=(el.dataset.search||'').includes(q)?'':'none');applyFilter();});
document.getElementById('searchPending').addEventListener('input',function(){const q=this.value.toLowerCase();document.querySelectorAll('#pendingList .pending-item').forEach(el=>el.style.display=(el.dataset.search||'').includes(q)?'':'none');});

// ── Copy ────────────────────────────────────────
function copyAddr(btn){navigator.clipboard.writeText(btn.dataset.addr).then(()=>{btn.classList.add('copied');btn.querySelector('.icon-copy').style.display='none';btn.querySelector('.icon-check').style.display='';setTimeout(()=>{btn.classList.remove('copied');btn.querySelector('.icon-copy').style.display='';btn.querySelector('.icon-check').style.display='none';},1500);});}

// ══════════════════════════════════════════════════
//  SORT & FILTER (localStorage)
// ══════════════════════════════════════════════════
function applySort(){
    const val = document.getElementById('sortSelect').value;
    localStorage.setItem(LS_SORT, val);
    const list = document.getElementById('compareList');
    const items = [...list.querySelectorAll('.project-item')];
    items.sort((a,b)=>{
        if(val==='score_desc'){
            const sa=a.dataset.score==='none'?-1:parseFloat(a.dataset.score);
            const sb=b.dataset.score==='none'?-1:parseFloat(b.dataset.score);
            return sb-sa;
        }
        if(val==='score_asc'){
            const sa=a.dataset.score==='none'?999:parseFloat(a.dataset.score);
            const sb=b.dataset.score==='none'?999:parseFloat(b.dataset.score);
            return sa-sb;
        }
        return (b.dataset.completed||'').localeCompare(a.dataset.completed||'');
    });
    items.forEach(el=>list.appendChild(el));
    applyFilter();
}

function applyFilter(){
    const hide = document.getElementById('hideNoGaf').checked;
    localStorage.setItem(LS_HIDE, hide?'1':'0');
    document.querySelectorAll('#compareList .project-item').forEach(el=>{
        if(hide && el.dataset.hasGaf!=='yes'){
            el.classList.add('no-gaf-hidden');
        } else {
            el.classList.remove('no-gaf-hidden');
        }
    });
}

// Restore from localStorage
(function(){
    const s = localStorage.getItem(LS_SORT);
    if(s){document.getElementById('sortSelect').value=s;}
    const h = localStorage.getItem(LS_HIDE);
    if(h==='1'){document.getElementById('hideNoGaf').checked=true;}
    applySort();
})();

// ══════════════════════════════════════════════════
//  COMPARE TAB
// ══════════════════════════════════════════════════
let activeEl = null;
let currentGafUrl = null;
let currentFolder = null;

function selectProject(el){
    if(activeEl) activeEl.classList.remove('active');
    el.classList.add('active'); activeEl=el;
    currentFolder = el.dataset.folder;
    currentGafUrl = null;
    loadGaf(el.dataset.address, el);
    loadPdf(el.dataset.folder);
    // Show cached analysis if available
    loadCachedAnalysis(el.dataset.folder);
    updateAnalyzeBtn();
}

function loadGaf(addr, el){
    const body=document.getElementById('gafBody'),link=document.getElementById('gafLink');
    body.innerHTML='<div class="placeholder"><div><div class="spinner"></div>Fetching GAF…</div></div>';
    link.style.display='none';

    // Check if we already have cached URL
    if(el && el.dataset.gafUrl){
        currentGafUrl = el.dataset.gafUrl;
        body.innerHTML='<iframe src="'+esc(currentGafUrl)+'"></iframe>';
        link.href=currentGafUrl; link.style.display='';
        updateAnalyzeBtn();
        return;
    }

    fetch(GAF_FETCH_URL+'?address='+encodeURIComponent(addr))
        .then(r=>{if(!(r.headers.get('content-type')||'').includes('application/json'))return r.text().then(t=>{throw new Error('Non-JSON ('+r.status+'): '+t.substring(0,150));});return r.json();})
        .then(d=>{
            if(d.report_url){
                currentGafUrl=d.report_url;
                body.innerHTML='<iframe src="'+esc(d.report_url)+'"></iframe>';
                link.href=d.report_url;link.style.display='';
                if(el){el.dataset.hasGaf='yes';el.dataset.gafUrl=d.report_url;updateGafBadge(el,'found');}
                // Cache the GAF URL
                saveCompareCache(currentFolder,{has_gaf:true,gaf_url:d.report_url});
            } else {
                body.innerHTML='<div class="placeholder"><div><div class="icon">⚠️</div>'+esc(d.message||'No GAF.')+'</div></div>';
                if(el){el.dataset.hasGaf='no';updateGafBadge(el,'none');}
                saveCompareCache(currentFolder,{has_gaf:false});
            }
            updateAnalyzeBtn(); applyFilter();
        })
        .catch(e=>{body.innerHTML='<div class="placeholder"><div><div class="icon">❌</div>Error<div class="err-detail">'+esc(String(e))+'</div></div></div>';if(el){el.dataset.hasGaf='no';updateGafBadge(el,'none');}updateAnalyzeBtn();});
}

function loadPdf(folder){
    const body=document.getElementById('projBody'),link=document.getElementById('projLink');
    const u='saves/'+encodeURIComponent(folder)+'/Report.pdf';
    body.innerHTML='<iframe src="'+esc(u)+'"></iframe>';link.href=u;link.style.display='';
}

function updateGafBadge(el,state){
    const b=el.querySelector('.gaf-badge');if(!b)return;
    b.className='badge gaf-badge '+(state==='found'?'gaf-found':'gaf-none');
    b.textContent=state==='found'?'GAF ✓':'No GAF';
}

function saveCompareCache(folder, data){
    // Merge with existing
    const form=new FormData();
    form.append('_action','write_compare_cache');
    form.append('folder',folder);
    // We need to read existing first, then merge
    const existing = compareCacheLocal[folder] || {};
    const merged = {...existing, ...data, updated_at: new Date().toISOString()};
    compareCacheLocal[folder] = merged;
    form.append('data',JSON.stringify(merged));
    fetch(SELF_URL,{method:'POST',body:form}).catch(()=>{});
}

// Local mirror of compare cache
const compareCacheLocal = <?=json_encode((object)$compareCache)?>;

function loadCachedAnalysis(folder){
    const cc = compareCacheLocal[folder];
    const scores = document.getElementById('analysisScores');
    const result = document.getElementById('analysisResult');
    const status = document.getElementById('analysisStatus');
    if(cc && cc.data){
        showScores(cc.discrepancy_score, cc.discrepancy_pct);
        result.innerHTML = renderStructured(cc.data);
        result.style.display = '';
        status.textContent = 'Cached analysis from '+(cc.analyzed_at||cc.updated_at||'earlier');
        const body=document.getElementById('analysisBody');
        if(body.classList.contains('collapsed')) toggleAnalysis();
    } else if(cc && cc.analysis) {
        // Old markdown cache — show as-is, suggest re-running
        showScores(cc.discrepancy_score, cc.discrepancy_pct);
        result.innerHTML = '<div style="color:var(--text-dim);margin-bottom:8px;font-size:10px">⚠️ Old format cache — re-run analysis for structured view</div><pre style="white-space:pre-wrap;font-size:11px;color:var(--text-dim)">' + esc(cc.analysis) + '</pre>';
        result.style.display = '';
        status.textContent = 'Cached (old format) — re-analyze for structured view';
        const body=document.getElementById('analysisBody');
        if(body.classList.contains('collapsed')) toggleAnalysis();
    } else {
        scores.style.display='none';
        result.style.display='none';
        result.innerHTML='';
        status.textContent = currentGafUrl ? 'Ready' : 'Load both reports to enable';
    }
}

// Pre-check GAF for unchecked compare items
document.addEventListener('DOMContentLoaded',()=>{
    const items=[...document.querySelectorAll('#compareList .project-item')].filter(el=>el.dataset.hasGaf==='unknown');
    let i=0;
    (function next(){
        if(i>=items.length)return;
        const el=items[i++],addr=el.dataset.address;
        fetch(GAF_FETCH_URL+'?address='+encodeURIComponent(addr))
            .then(r=>{if(!(r.headers.get('content-type')||'').includes('application/json'))throw 0;return r.json();})
            .then(d=>{
                if(d.report_url){el.dataset.hasGaf='yes';el.dataset.gafUrl=d.report_url;updateGafBadge(el,'found');saveCompareCache(el.dataset.folder,{has_gaf:true,gaf_url:d.report_url});}
                else{el.dataset.hasGaf='no';updateGafBadge(el,'none');saveCompareCache(el.dataset.folder,{has_gaf:false});}
                applyFilter();
            })
            .catch(()=>{el.dataset.hasGaf='no';updateGafBadge(el,'none');applyFilter();})
            .finally(()=>setTimeout(next,200));
    })();
});

// ══════════════════════════════════════════════════
//  GEMINI ANALYSIS
// ══════════════════════════════════════════════════
function toggleAnalysis(){
    document.getElementById('analysisBody').classList.toggle('collapsed');
    document.getElementById('analysisChevron').classList.toggle('open');
}

function updateAnalyzeBtn(){
    const btn=document.getElementById('analyzeBtn'),st=document.getElementById('analysisStatus');
    if(currentGafUrl&&currentFolder){btn.disabled=false;if(!compareCacheLocal[currentFolder]?.analysis)st.textContent='Ready — both reports loaded';}
    else{btn.disabled=true;st.textContent=currentFolder?'Waiting for GAF…':'Select a project';}
}

function showScores(score, pct){
    const sc=document.getElementById('analysisScores');
    sc.style.display='flex';
    const sv=document.getElementById('scoreVal'),pv=document.getElementById('pctVal');
    const sCard=document.getElementById('scoreCard'),pCard=document.getElementById('pctCard');
    sv.textContent=score!==null&&score!==undefined?Math.round(score):'—';
    pv.textContent=pct!==null&&pct!==undefined?pct.toFixed(1)+'%':'—';
    ['low','med','high'].forEach(c=>{sCard.classList.remove(c);pCard.classList.remove(c);});
    if(score!==null){const cl=score>=40?'high':score>=15?'med':'low';sCard.classList.add(cl);pCard.classList.add(cl);}
}

function runAnalysis(){
    if(!currentGafUrl||!currentFolder)return;
    const btn=document.getElementById('analyzeBtn'),st=document.getElementById('analysisStatus');
    const result=document.getElementById('analysisResult');
    btn.disabled=true;btn.innerHTML='<span class="spinner-inline"></span> Analyzing…';
    st.textContent='Sending both PDFs to Gemini…';
    result.style.display='none';
    document.getElementById('analysisScores').style.display='none';

    const body=document.getElementById('analysisBody');
    if(body.classList.contains('collapsed'))toggleAnalysis();

    const form=new FormData();
    form.append('_action','analyze');
    form.append('gaf_url',currentGafUrl);
    form.append('project_folder',currentFolder);

    fetch(SELF_URL,{method:'POST',body:form}).then(r=>r.json()).then(data=>{
        if(data.ok){
            showScores(data.discrepancy_score, data.discrepancy_pct);
            result.innerHTML=renderStructured(data.data);result.style.display='';
            st.textContent='Analysis complete';
            saveCompareCache(currentFolder,{
                data:data.data,
                discrepancy_score:data.discrepancy_score,
                discrepancy_pct:data.discrepancy_pct,
                analyzed_at:new Date().toISOString()
            });
            // Update sidebar badges
            if(activeEl){
                activeEl.dataset.score=data.discrepancy_score!=null?data.discrepancy_score:'none';
                activeEl.dataset.pct=data.discrepancy_pct!=null?data.discrepancy_pct:'none';
                activeEl.dataset.analyzed='yes';
                updateSidebarScoreBadge(activeEl,data.discrepancy_score,data.discrepancy_pct);
            }
        } else {
            result.innerHTML='<div style="color:var(--red)">❌ '+esc(data.error||'Error')+'</div>';result.style.display='';
            st.textContent='Failed';
        }
    }).catch(e=>{
        result.innerHTML='<div style="color:var(--red)">❌ '+esc(String(e))+'</div>';result.style.display='';
        st.textContent='Request failed';
    }).finally(()=>{
        btn.disabled=false;
        btn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> Compare Measurements';
        updateAnalyzeBtn();
    });
}

function updateSidebarScoreBadge(el, score, pct){
    // Remove old score/analyzed badges
    el.querySelectorAll('.badge.score,.badge.analyzed').forEach(b=>b.remove());
    const badges = el.querySelector('.badges');
    if(score!==null&&score!==undefined){
        const cl=score>=40?'high':score>=15?'med':'low';
        const b=document.createElement('span');
        b.className='badge score '+cl;
        b.textContent=(pct!=null?pct.toFixed(1)+'%':Math.round(score));
        badges.appendChild(b);
    }
    const ab=document.createElement('span');
    ab.className='badge analyzed';ab.textContent='analyzed';
    badges.appendChild(ab);
}

// ══════════════════════════════════════════════════
//  BATCH ANALYZE
// ══════════════════════════════════════════════════
let batchRunning = false;
let batchAborted = false;

function batchAnalyze(){
    if(batchRunning){batchAborted=true;return;}

    // Get all items with GAF but not yet analyzed
    const items=[...document.querySelectorAll('#compareList .project-item')].filter(el=>el.dataset.hasGaf==='yes'&&el.dataset.analyzed!=='yes');
    if(items.length===0){alert('No un-analyzed projects with GAF reports found.');return;}

    if(!confirm('Run Gemini analysis on '+items.length+' project(s)? This may take a while and use API credits.')){return;}

    batchRunning=true;batchAborted=false;
    const btn=document.getElementById('batchBtn');
    btn.textContent='⏹ Stop Batch';
    const st=document.getElementById('analysisStatus');

    let idx=0;
    function next(){
        if(batchAborted||idx>=items.length){
            batchRunning=false;batchAborted=false;
            btn.textContent='⚡ Batch Analyze';btn.disabled=false;
            st.textContent='Batch '+(idx>=items.length?'complete':'stopped')+': '+idx+'/'+items.length;
            return;
        }
        const el=items[idx++];
        const addr=el.dataset.address;
        const folder=el.dataset.folder;
        const gafUrl=el.dataset.gafUrl;

        st.textContent='Batch '+idx+'/'+items.length+': '+addr.substring(0,40)+'…';

        const form=new FormData();
        form.append('_action','analyze');
        form.append('gaf_url',gafUrl);
        form.append('project_folder',folder);

        fetch(SELF_URL,{method:'POST',body:form}).then(r=>r.json()).then(data=>{
            if(data.ok){
                saveCompareCache(folder,{
                    data:data.data,
                    discrepancy_score:data.discrepancy_score,
                    discrepancy_pct:data.discrepancy_pct,
                    analyzed_at:new Date().toISOString()
                });
                el.dataset.score=data.discrepancy_score!=null?data.discrepancy_score:'none';
                el.dataset.pct=data.discrepancy_pct!=null?data.discrepancy_pct:'none';
                el.dataset.analyzed='yes';
                updateSidebarScoreBadge(el,data.discrepancy_score,data.discrepancy_pct);
            }
        }).catch(()=>{}).finally(()=>setTimeout(next,2000)); // 2s gap between batch calls
    }
    next();
}

// ══════════════════════════════════════════════════
//  PENDING TAB
// ══════════════════════════════════════════════════
let scanRunning=false,scanAborted=false;

function scanPending(){
    if(scanRunning){scanAborted=true;return;}
    scanRunning=true;scanAborted=false;
    const btn=document.getElementById('scanBtn'),saveBtn=document.getElementById('saveBtn');
    const statusEl=document.getElementById('pendingStatus'),progBar=document.getElementById('progressBar'),progFill=document.getElementById('progressFill');
    btn.innerHTML='⏹ Stop';progBar.style.display='';
    const items=[...document.querySelectorAll('#pendingList .pending-item')];
    const toCheck=items.filter(el=>el.dataset.gaf==='unknown');
    const total=items.length,remaining=toCheck.length,done0=total-remaining;
    if(remaining===0){statusEl.textContent='All '+total+' scanned.';btn.textContent='All Scanned ✓';scanRunning=false;progBar.style.display='none';updatePendingSave();return;}
    let idx=0,batch={},bc=0;
    function flush(cb){if(!bc){cb&&cb();return;}const f=new FormData();f.append('_action','update_index');f.append('batch',JSON.stringify(batch));fetch(SELF_URL,{method:'POST',body:f}).then(r=>r.json()).then(()=>{batch={};bc=0;cb&&cb();}).catch(()=>{cb&&cb();});}
    function finish(){flush(()=>{scanRunning=false;progBar.style.display='none';const c=countPendingGaf();statusEl.textContent=c.checked+'/'+total+' scanned • '+c.found+' with GAF';btn.textContent=(c.checked>=total)?'All Scanned ✓':'Resume Scan';btn.disabled=false;updatePendingSave();});}
    function next(){
        if(scanAborted||idx>=remaining){finish();return;}
        const el=toCheck[idx++],addr=el.dataset.address;
        const d=done0+idx,pct=Math.round((d/total)*100);
        statusEl.textContent='Checking '+d+'/'+total+'…';progFill.style.width=pct+'%';
        const badge=el.querySelector('.pending-gaf-badge');
        fetch(GAF_FETCH_URL+'?address='+encodeURIComponent(addr))
            .then(r=>{if(!(r.headers.get('content-type')||'').includes('application/json'))throw 0;return r.json();})
            .then(data=>{
                if(data.report_url){el.dataset.gaf='found';el.classList.add('has-gaf');badge.className='badge pending-gaf-badge gaf-found';badge.textContent='GAF ✓';batch[addr]={has_gaf:true,report_url:data.report_url,checked_at:new Date().toISOString()};}
                else{el.dataset.gaf='none';badge.className='badge pending-gaf-badge gaf-none';badge.textContent='No GAF';batch[addr]={has_gaf:false,checked_at:new Date().toISOString()};}
            }).catch(()=>{el.dataset.gaf='none';badge.className='badge pending-gaf-badge gaf-none';badge.textContent='Error';batch[addr]={has_gaf:false,error:true,checked_at:new Date().toISOString()};})
            .finally(()=>{bc++;if(bc>=10)flush(()=>setTimeout(next,200));else setTimeout(next,200);});
    }
    next();
}
function countPendingGaf(){let c=0,f=0;document.querySelectorAll('#pendingList .pending-item').forEach(el=>{if(el.dataset.gaf!=='unknown')c++;if(el.dataset.gaf==='found')f++;});return{checked:c,found:f};}
function updatePendingSave(){document.getElementById('saveBtn').disabled=countPendingGaf().found===0;}
function saveSnapshot(){
    const r=[];document.querySelectorAll('#pendingList .pending-item').forEach(el=>{if(el.dataset.gaf==='found')r.push(el.dataset.address);});
    if(!r.length)return;const st=document.getElementById('pendingStatus'),sb=document.getElementById('saveBtn');sb.disabled=true;st.textContent='Saving…';
    const f=new FormData();f.append('_action','save_snapshot');f.append('data',JSON.stringify(r));
    fetch(SELF_URL,{method:'POST',body:f}).then(r=>r.json()).then(d=>{if(d.ok)st.innerHTML='✅ Saved <strong>'+esc(d.file)+'</strong> ('+d.count+')';else{st.textContent='❌ '+(d.error||'failed');sb.disabled=false;}}).catch(e=>{st.textContent='❌ '+String(e);sb.disabled=false;});
}
function clearIndex(){if(!confirm('Clear pending GAF cache?'))return;const f=new FormData();f.append('_action','clear_index');fetch(SELF_URL,{method:'POST',body:f}).then(()=>location.reload());}

// ── Draggable divider ───────────────────────────
(function(){const div=document.getElementById('divider'),gp=document.getElementById('gafPanel'),pp=document.getElementById('projPanel'),pan=document.getElementById('panels');let d=false;div.addEventListener('mousedown',e=>{e.preventDefault();d=true;div.classList.add('dragging');document.body.style.cursor='col-resize';document.body.style.userSelect='none';document.querySelectorAll('.panel-body iframe').forEach(f=>f.style.pointerEvents='none');});document.addEventListener('mousemove',e=>{if(!d)return;const r=pan.getBoundingClientRect(),p=Math.max(15,Math.min(85,((e.clientX-r.left)/r.width)*100));gp.style.flex='none';gp.style.width=p+'%';pp.style.flex='none';pp.style.width=(100-p)+'%';});document.addEventListener('mouseup',()=>{if(!d)return;d=false;div.classList.remove('dragging');document.body.style.cursor='';document.body.style.userSelect='';document.querySelectorAll('.panel-body iframe').forEach(f=>f.style.pointerEvents='');});})();

// ── Utilities ───────────────────────────────────
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

const MEAS_LABELS = {
    roof_area: 'Roof Area',
    roof_facets: 'Roof Facets',
    predominant_pitch: 'Predominant Pitch',
    ridges_hips: 'Ridges / Hips',
    valleys: 'Valleys',
    rakes: 'Rakes',
    eaves: 'Eaves',
    skylights: 'Skylights'
};

function fmtVal(v, unit) {
    if (v === null || v === undefined) return '<span style="color:var(--text-dim)">—</span>';
    if (unit === 'pitch') return esc(String(v));
    if (unit === 'count') return String(v);
    if (unit === 'sqft') return Number(v).toLocaleString() + ' sqft';
    if (unit === 'ft') return Number(v).toLocaleString() + ' ft';
    return String(v);
}

function diffBadge(pct, flag) {
    if (pct === null || pct === undefined) {
        if (flag) return '<span class="d-badge d-miss">MISSING</span>';
        return '<span class="d-badge d-na">N/A</span>';
    }
    const cls = pct > 10 ? 'd-high' : pct > 5 ? 'd-med' : 'd-low';
    return '<span class="d-badge ' + cls + '">' + (flag ? '⚠️ ' : '') + pct.toFixed(1) + '%</span>';
}

function renderStructured(data) {
    if (!data) return '<div style="color:var(--text-dim)">No data</div>';

    let html = '';

    // Summary
    if (data.summary) {
        html += '<div class="analysis-summary">' + esc(data.summary) + '</div>';
    }

    // Missing structures warning
    if (data.missing_structures && data.missing_structures.length > 0) {
        html += '<div class="missing-warn">';
        html += '<strong>⚠️ Missing Structures:</strong><br>';
        data.missing_structures.forEach(ms => {
            html += '<span class="d-badge d-miss" style="margin:2px 4px 2px 0;display:inline-block">' +
                esc(ms.name) + ' — in ' + esc(ms.present_in) + ' only, missing from ' + esc(ms.missing_from) +
                '</span><br>';
        });
        html += '</div>';
    }

    // Structures
    const structs = data.structures || [];
    structs.forEach((s, si) => {
        html += '<div class="struct-block">';
        html += '<div class="struct-header">';
        html += '<strong>' + esc(s.name || ('Structure ' + (si + 1))) + '</strong>';
        if (!s.in_gaf) html += ' <span class="d-badge d-miss">Not in GAF</span>';
        if (!s.in_project) html += ' <span class="d-badge d-miss">Not in Project</span>';
        html += '</div>';

        html += '<table class="struct-table"><thead><tr>';
        html += '<th>Measurement</th><th>GAF</th><th>Project</th><th>Diff</th>';
        html += '</tr></thead><tbody>';

        const m = s.measurements || {};
        Object.keys(MEAS_LABELS).forEach(key => {
            const row = m[key];
            if (!row) {
                html += '<tr><td>' + MEAS_LABELS[key] + '</td><td colspan="3" style="color:var(--text-dim)">Not reported</td></tr>';
                return;
            }
            const flagCls = row.flag ? ' class="flagged-row"' : '';
            html += '<tr' + flagCls + '>';
            html += '<td><strong>' + MEAS_LABELS[key] + '</strong></td>';
            html += '<td>' + fmtVal(row.gaf, row.unit) + '</td>';
            html += '<td>' + fmtVal(row.project, row.unit) + '</td>';
            html += '<td>' + diffBadge(row.diff_pct, row.flag) + '</td>';
            html += '</tr>';
        });

        html += '</tbody></table></div>';
    });

    // Notes
    if (data.notes) {
        html += '<div class="analysis-notes"><strong>Notes:</strong> ' + esc(data.notes) + '</div>';
    }

    return html;
}
</script>
</body>
</html>
