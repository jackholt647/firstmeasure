<?php
require_once __DIR__ . '/_storage.php';

if (defined('FIRSTMEASURE_PROJECT_API_LOADED')) {
    return;
}
define('FIRSTMEASURE_PROJECT_API_LOADED', true);

if (!defined('PRICE_RESIDENTIAL')) define('PRICE_RESIDENTIAL', 7);
if (!defined('PRICE_COMMERCIAL')) define('PRICE_COMMERCIAL', 12);
if (!defined('PRICE_MULTIFAMILY')) define('PRICE_MULTIFAMILY', 12);

function projectTypePrice($type) {
    $map = [
        'residential' => PRICE_RESIDENTIAL,
        'commercial' => PRICE_COMMERCIAL,
        'multifamily' => PRICE_MULTIFAMILY,
    ];
    $key = strtolower(trim((string)$type));
    return $map[$key] ?? PRICE_RESIDENTIAL;
}

function getFolder($address) {
    return md5(strtolower(trim((string)$address)));
}

function saveManifest($manifestPath, $data) {
    $dir = dirname($manifestPath);
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    return @file_put_contents($manifestPath, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
}

function fm_api_base_url() {
    static $base = null;
    if ($base !== null) return $base;

    $envBase = getenv('FIRSTMEASURE_API_BASE');
    if (is_string($envBase) && trim($envBase) !== '') {
        $base = rtrim(trim($envBase), '/');
        return $base;
    }

    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    $hostOnly = preg_replace('/:\d+$/', '', $host);
    if ($hostOnly === '127.0.0.1' || $hostOnly === 'localhost') {
        $base = 'http://127.0.0.1:3111/v1/firstmeasure';
        return $base;
    }

    $forwardedProto = strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
    $scheme = ($forwardedProto === 'https' || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')) ? 'https' : 'http';
    $publicHost = (string)($_SERVER['HTTP_HOST'] ?? 'app.1m8.ai');
    $base = $scheme . '://' . $publicHost . '/v1/firstmeasure';
    return $base;
}

function fm_json_decode($raw, $fallback = null) {
    if (!is_string($raw) || trim($raw) === '') return $fallback;
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : $fallback;
}

function fm_api_request($method, $path, $opts = []) {
    $method = strtoupper(trim((string)$method));
    $url = rtrim(fm_api_base_url(), '/') . '/' . ltrim((string)$path, '/');
    if (!empty($opts['query']) && is_array($opts['query'])) {
        $qs = http_build_query($opts['query']);
        if ($qs !== '') {
            $url .= (strpos($url, '?') === false ? '?' : '&') . $qs;
        }
    }

    $headers = ['Accept: application/json'];
    $body = null;

    if (isset($opts['json'])) {
        $body = json_encode($opts['json']);
        $headers[] = 'Content-Type: application/json';
    } elseif (!empty($opts['multipart']) && is_array($opts['multipart'])) {
        $multipart = [];
        foreach ($opts['multipart'] as $k => $v) {
            if (is_array($v) && isset($v['path'])) {
                $mime = $v['type'] ?? 'application/octet-stream';
                $name = $v['name'] ?? basename((string)$v['path']);
                if (function_exists('curl_init') && class_exists('CURLFile')) {
                    $multipart[$k] = new CURLFile((string)$v['path'], $mime, $name);
                } else {
                    $multipart[$k] = [
                        'path' => (string)$v['path'],
                        'type' => $mime,
                        'name' => $name
                    ];
                }
            } else {
                $multipart[$k] = $v;
            }
        }
        $body = $multipart;
        $headers = ['Accept: application/json'];
    } elseif (array_key_exists('body', $opts)) {
        $body = $opts['body'];
    }

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        $responseHeaders = [];
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_CONNECTTIMEOUT => $opts['connect_timeout'] ?? 3,
            CURLOPT_TIMEOUT => $opts['timeout'] ?? 45,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_HEADERFUNCTION => function ($curl, $header) use (&$responseHeaders) {
                $len = strlen($header);
                $parts = explode(':', $header, 2);
                if (count($parts) === 2) {
                    $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return $len;
            }
        ]);

        if ($body !== null && $method !== 'GET') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $resp = curl_exec($ch);
        $curlErr = curl_error($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return [
            'ok' => ($curlErr === '' && $status >= 200 && $status < 300),
            'status' => $status,
            'error' => $curlErr !== '' ? $curlErr : null,
            'headers' => $responseHeaders,
            'body' => $resp === false ? '' : $resp,
            'json' => fm_json_decode($resp, null),
            'url' => $url,
        ];
    }

    $fallback = fm_stream_http_request($method, $url, $headers, $body, !empty($opts['multipart']), $opts['timeout'] ?? 45);
    $fallback['json'] = fm_json_decode($fallback['body'], null);
    $fallback['url'] = $url;
    return $fallback;
}

function fm_stream_http_request($method, $url, $headers, $body, $isMultipart = false, $timeout = 45) {
    $headerLines = $headers;
    if ($isMultipart && is_array($body)) {
        [$contentType, $rawBody] = fm_build_multipart_payload($body);
        $headerLines[] = 'Content-Type: ' . $contentType;
        $body = $rawBody;
    }

    $context = stream_context_create([
        'http' => [
            'method' => $method,
            'timeout' => $timeout,
            'ignore_errors' => true,
            'header' => implode("\r\n", $headerLines),
            'content' => ($method !== 'GET' && $body !== null) ? $body : ''
        ],
        'ssl' => [
            'verify_peer' => false,
            'verify_peer_name' => false,
        ]
    ]);

    $resp = @file_get_contents($url, false, $context);
    $respHeaders = [];
    $status = 0;
    foreach (($http_response_header ?? []) as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) {
            $status = (int)$m[1];
            continue;
        }
        $parts = explode(':', $line, 2);
        if (count($parts) === 2) {
            $respHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
        }
    }

    return [
        'ok' => ($status >= 200 && $status < 300),
        'status' => $status,
        'error' => $resp === false ? 'stream_request_failed' : null,
        'headers' => $respHeaders,
        'body' => $resp === false ? '' : $resp,
    ];
}

function fm_build_multipart_payload($multipart) {
    $boundary = '----FirstMeasure' . md5(uniqid('', true));
    $chunks = [];
    foreach ($multipart as $name => $value) {
        if ((class_exists('CURLFile') && $value instanceof CURLFile) || (is_array($value) && isset($value['path']))) {
            if (class_exists('CURLFile') && $value instanceof CURLFile) {
                $filePath = $value->getFilename();
                $fileName = $value->getPostFilename() ?: basename($filePath);
                $mimeType = $value->getMimeType() ?: 'application/octet-stream';
            } else {
                $filePath = (string)$value['path'];
                $fileName = (string)($value['name'] ?? basename($filePath));
                $mimeType = (string)($value['type'] ?? 'application/octet-stream');
            }
            $content = @file_get_contents($filePath);
            if ($content === false) $content = '';
            $chunks[] = "--{$boundary}\r\n"
                . 'Content-Disposition: form-data; name="' . $name . '"; filename="' . $fileName . "\"\r\n"
                . 'Content-Type: ' . $mimeType . "\r\n\r\n"
                . $content . "\r\n";
        } else {
            $chunks[] = "--{$boundary}\r\n"
                . 'Content-Disposition: form-data; name="' . $name . "\"\r\n\r\n"
                . (string)$value . "\r\n";
        }
    }
    $chunks[] = "--{$boundary}--\r\n";
    return ['multipart/form-data; boundary=' . $boundary, implode('', $chunks)];
}

function fm_api_json($method, $path, $json = null, $query = null) {
    $opts = [];
    if ($json !== null) $opts['json'] = $json;
    if ($query !== null) $opts['query'] = $query;
    return fm_api_request($method, $path, $opts);
}

function fm_norm_email($value) {
    return strtolower(trim((string)$value));
}

function fm_norm_string($value) {
    return trim((string)$value);
}

function fm_first_nonblank(...$values) {
    foreach ($values as $value) {
        if ($value === null) continue;
        $string = trim((string)$value);
        if ($string !== '') return $string;
    }
    return '';
}

function fm_as_array($value) {
    return is_array($value) ? $value : [];
}

function fm_as_record($value) {
    return is_array($value) ? $value : [];
}

function fm_default_rejection_reasons() {
    return [
        ['id' => 'no_height_map', 'label' => 'No height map', 'icon' => 'fas fa-mountain'],
        ['id' => 'no_satellite_image', 'label' => 'No satellite image', 'icon' => 'fas fa-satellite'],
        ['id' => 'obscured_visibility', 'label' => 'Obscured visibility', 'icon' => 'fas fa-cloud'],
        ['id' => 'invalid_pin_placement', 'label' => 'Invalid pin placement', 'icon' => 'fas fa-map-pin'],
        ['id' => 'incorrect_structure_type', 'label' => 'Incorrect Structure Type', 'icon' => 'fas fa-building'],
    ];
}

function fm_normalize_rejection_reason_id($value) {
    $id = strtolower(trim((string)$value));
    $id = preg_replace('/[^a-z0-9]+/', '_', $id);
    $id = trim((string)$id, '_');
    return $id;
}

function fm_rejection_reasons() {
    static $reasons = null;
    if (is_array($reasons)) return $reasons;

    $path = storagePath('config/rejection_reasons.json');
    $raw = is_file($path) ? @file_get_contents($path) : false;
    $decoded = $raw !== false ? json_decode((string)$raw, true) : null;
    $source = is_array($decoded) ? $decoded : fm_default_rejection_reasons();

    $normalized = [];
    $seen = [];
    foreach ($source as $entry) {
        if (!is_array($entry)) continue;
        $id = fm_normalize_rejection_reason_id($entry['id'] ?? '');
        $label = trim((string)($entry['label'] ?? ''));
        if ($id === '' || $label === '' || isset($seen[$id])) continue;
        $seen[$id] = true;
        $normalized[] = [
            'id' => $id,
            'label' => $label,
            'icon' => trim((string)($entry['icon'] ?? 'fas fa-circle-exclamation')),
        ];
    }

    $reasons = !empty($normalized) ? $normalized : fm_default_rejection_reasons();
    return $reasons;
}

function fm_rejection_reason_id_from_value($value) {
    $candidate = fm_normalize_rejection_reason_id($value);
    if ($candidate === '') return '';

    foreach (fm_rejection_reasons() as $reason) {
        $id = (string)($reason['id'] ?? '');
        if ($candidate === $id) return $id;
        if ($candidate === fm_normalize_rejection_reason_id($reason['label'] ?? '')) return $id;
    }
    return '';
}

function fm_rejection_reason_label($id) {
    $id = fm_rejection_reason_id_from_value($id);
    if ($id === '') return '';
    foreach (fm_rejection_reasons() as $reason) {
        if (($reason['id'] ?? '') === $id) return (string)($reason['label'] ?? '');
    }
    return '';
}

function fm_rejection_reason_ids() {
    return array_values(array_map(function($reason) {
        return (string)($reason['id'] ?? '');
    }, fm_rejection_reasons()));
}

function fm_manifest_ts($manifest, $key) {
    $m = fm_as_array($manifest);
    $timestamps = fm_as_array($m['timestamps'] ?? []);
    $value = $timestamps[$key] ?? ($m[$key] ?? null);
    return is_string($value) ? $value : null;
}

function fm_extract_workflow($manifest) {
    return fm_as_array(fm_as_array($manifest)['workflow'] ?? []);
}

function fm_actor_email($actor) {
    return fm_norm_email(fm_as_array($actor)['email'] ?? '');
}

function fm_actor_name($actor) {
    return fm_norm_string(fm_as_array($actor)['name'] ?? '');
}

function fm_manifest_work_history($manifest) {
    $m = fm_as_array($manifest);
    if (isset($m['work_history']) && is_array($m['work_history'])) return $m['work_history'];
    $workflow = fm_extract_workflow($m);
    if (isset($workflow['history']) && is_array($workflow['history'])) return $workflow['history'];
    return [];
}

function fm_ts_value($raw) {
    if ($raw === null) return null;
    $value = trim((string)$raw);
    if ($value === '') return null;
    $ts = strtotime($value);
    return ($ts === false) ? null : $ts;
}

function fm_project_timed_events($manifest) {
    $events = [];
    foreach (fm_manifest_work_history($manifest) as $entry) {
        $entry = fm_as_array($entry);
        if (!$entry) continue;
        $event = strtolower(trim((string)($entry['event'] ?? ($entry['type'] ?? ''))));
        $ts = fm_ts_value($entry['ts'] ?? ($entry['at'] ?? ($entry['date'] ?? ($entry['created_at'] ?? null))));
        if ($event === '' || $ts === null) continue;
        $events[] = ['event' => $event, 'ts' => $ts];
    }
    usort($events, function($a, $b) {
        if ($a['ts'] !== $b['ts']) return $a['ts'] <=> $b['ts'];
        return strcmp((string)$a['event'], (string)$b['event']);
    });
    return $events;
}

function fm_project_requeue_pause_seconds($manifest, $windowStartTs, $windowEndTs = null) {
    $windowStartTs = (int)$windowStartTs;
    $windowEndTs = $windowEndTs === null ? time() : (int)$windowEndTs;
    if ($windowStartTs <= 0 || $windowEndTs <= $windowStartTs) return 0;

    $pauseEvents = [
        'qa_rejected' => true,
        'qa_sent_back_to_tech' => true,
        'manager_rejected' => true,
        'manager_sent_back_to_tech' => true,
        'force_requeued' => true,
        'forced_requeue' => true,
        'project_force_requeued' => true,
        'sent_to_requeue' => true,
        'moved_to_requeue' => true,
        'requeued' => true,
    ];
    $resumeEvents = [
        'claimed_correction' => true,
        'claimed_new' => true,
        'reopened_project_claimed' => true,
    ];

    $pausedAt = null;
    $pausedSeconds = 0;
    foreach (fm_project_timed_events($manifest) as $entry) {
        $eventTs = (int)$entry['ts'];
        if ($eventTs < $windowStartTs) continue;
        if ($eventTs > $windowEndTs) break;

        $event = (string)$entry['event'];
        if (isset($pauseEvents[$event])) {
            if ($pausedAt === null) $pausedAt = $eventTs;
        } elseif (isset($resumeEvents[$event]) && $pausedAt !== null) {
            $pauseStart = max($pausedAt, $windowStartTs);
            if ($eventTs > $pauseStart) $pausedSeconds += ($eventTs - $pauseStart);
            $pausedAt = null;
        }
    }

    if ($pausedAt !== null) {
        $pauseStart = max($pausedAt, $windowStartTs);
        if ($windowEndTs > $pauseStart) $pausedSeconds += ($windowEndTs - $pauseStart);
    }

    return max(0, $pausedSeconds);
}

function fm_project_elapsed_seconds_excluding_requeue($manifest, $startTs, $endTs = null) {
    $startTs = (int)$startTs;
    $endTs = $endTs === null ? time() : (int)$endTs;
    if ($startTs <= 0 || $endTs <= $startTs) return 0;
    $elapsed = $endTs - $startTs;
    $paused = fm_project_requeue_pause_seconds($manifest, $startTs, $endTs);
    return max(0, $elapsed - $paused);
}

function fm_touch_technician_entry(&$entries, $email, $name, $event = null, $tsRaw = null, $extra = []) {
    $email = fm_norm_email($email);
    $name = fm_norm_string($name);
    if ($email === '' && $name === '') return;

    $key = $email !== '' ? ('email:' . $email) : ('name:' . strtolower($name));
    if (!isset($entries[$key]) || !is_array($entries[$key])) {
        $entries[$key] = [
            'email' => $email ?: null,
            'name' => $name ?: null,
            'first_ts' => null,
            'last_ts' => null,
            'first_event' => null,
            'last_event' => null,
            'claim_count' => 0,
            'correction_count' => 0,
            'sent_back_count' => 0,
            'events' => [],
            'is_current_assignee' => false,
            'is_correction_target' => false,
        ];
    }

    if ($email !== '' && empty($entries[$key]['email'])) $entries[$key]['email'] = $email;
    if ($name !== '' && empty($entries[$key]['name'])) $entries[$key]['name'] = $name;

    $tsValue = fm_ts_value($tsRaw);
    $tsStore = ($tsRaw !== null && trim((string)$tsRaw) !== '') ? trim((string)$tsRaw) : null;
    if ($tsValue !== null) {
        $firstTsValue = fm_ts_value($entries[$key]['first_ts'] ?? null);
        $lastTsValue = fm_ts_value($entries[$key]['last_ts'] ?? null);
        if ($firstTsValue === null || $tsValue < $firstTsValue) {
            $entries[$key]['first_ts'] = $tsStore;
            if ($event !== null && $event !== '') $entries[$key]['first_event'] = $event;
        }
        if ($lastTsValue === null || $tsValue >= $lastTsValue) {
            $entries[$key]['last_ts'] = $tsStore;
            if ($event !== null && $event !== '') $entries[$key]['last_event'] = $event;
        }
    } elseif (($entries[$key]['first_ts'] ?? null) === null && $tsStore !== null) {
        $entries[$key]['first_ts'] = $tsStore;
        if ($event !== null && $event !== '') $entries[$key]['first_event'] = $event;
    } elseif (($entries[$key]['last_ts'] ?? null) === null && $tsStore !== null) {
        $entries[$key]['last_ts'] = $tsStore;
        if ($event !== null && $event !== '') $entries[$key]['last_event'] = $event;
    }

    if ($event !== null && $event !== '') {
        $entries[$key]['events'][] = $event;
        if (in_array($event, ['claimed_new', 'claimed_correction', 'submitted_for_qa', 'correction_submitted', 'reopened_project_claimed'], true)) {
            $entries[$key]['claim_count']++;
        }
        if ($event === 'claimed_correction' || $event === 'correction_submitted') {
            $entries[$key]['correction_count']++;
        }
        if (in_array($event, ['qa_rejected', 'qa_sent_back_to_tech', 'manager_sent_back_to_tech'], true)) {
            $entries[$key]['sent_back_count']++;
        }
    }

    if (!empty($extra['is_current_assignee'])) $entries[$key]['is_current_assignee'] = true;
    if (!empty($extra['is_correction_target'])) $entries[$key]['is_correction_target'] = true;
}

function fm_manifest_technician_history($manifest) {
    $m = fm_as_array($manifest);
    $entries = [];

    foreach (fm_manifest_work_history($m) as $event) {
        $event = fm_as_array($event);
        if (!$event) continue;
        $workerEmail = $event['worker_email'] ?? ($event['assigned_to_email'] ?? null);
        $workerName = $event['worker_name'] ?? ($event['assigned_to_name'] ?? null);
        fm_touch_technician_entry(
            $entries,
            $workerEmail,
            $workerName,
            trim((string)($event['event'] ?? '')),
            $event['ts'] ?? ($event['date'] ?? null)
        );
    }

    foreach (fm_as_array($m['resubmission_claims'] ?? []) as $claim) {
        $claim = fm_as_array($claim);
        if (!$claim) continue;
        fm_touch_technician_entry(
            $entries,
            $claim['claimed_by_email'] ?? '',
            $claim['claimed_by_name'] ?? '',
            'reopened_project_claimed',
            $claim['claimed_at'] ?? null
        );
    }

    $workflow = fm_extract_workflow($m);
    $assigned = fm_as_array($workflow['assigned_to'] ?? []);
    fm_touch_technician_entry(
        $entries,
        $m['assigned_to_email'] ?? ($assigned['email'] ?? ''),
        $m['assigned_to_name'] ?? ($assigned['name'] ?? ''),
        'assigned_current',
        $m['assigned_at'] ?? ($workflow['assigned_at'] ?? ($m['updated_at'] ?? null)),
        ['is_current_assignee' => true]
    );

    $correction = fm_as_array($workflow['correction_to'] ?? []);
    fm_touch_technician_entry(
        $entries,
        $m['correction_to_email'] ?? ($correction['email'] ?? ''),
        $m['correction_to_name'] ?? ($correction['name'] ?? ''),
        'correction_target',
        $m['correction_requested_at'] ?? ($m['updated_at'] ?? null),
        ['is_correction_target' => true]
    );

    $history = array_values($entries);
    usort($history, function($a, $b) {
        $aFirst = fm_ts_value($a['first_ts'] ?? null) ?? PHP_INT_MAX;
        $bFirst = fm_ts_value($b['first_ts'] ?? null) ?? PHP_INT_MAX;
        if ($aFirst !== $bFirst) return $aFirst <=> $bFirst;
        $aLast = fm_ts_value($a['last_ts'] ?? null) ?? 0;
        $bLast = fm_ts_value($b['last_ts'] ?? null) ?? 0;
        if ($aLast !== $bLast) return $aLast <=> $bLast;
        return strcmp((string)($a['email'] ?? $a['name'] ?? ''), (string)($b['email'] ?? $b['name'] ?? ''));
    });

    foreach ($history as &$entry) {
        $entry['events'] = array_values(array_unique(array_filter(array_map('strval', fm_as_array($entry['events'] ?? [])))));
    }
    unset($entry);

    return $history;
}

function fm_pick_technician_entry($history, $mode = 'latest') {
    $history = array_values(array_filter(fm_as_array($history), 'is_array'));
    if (empty($history)) return null;
    return $mode === 'original' ? ($history[0] ?? null) : ($history[count($history) - 1] ?? null);
}

function fm_project_pay_technician_from_manifest($manifest, $techHistory = null) {
    $m = fm_as_array($manifest);
    $qaEmails = [];
    foreach ([
        $m['qa_claimed_by_email'] ?? null,
        $m['qa_approved_by_email'] ?? null,
        $m['qa_approved_by'] ?? null,
        $m['qa_reviewed_by_email'] ?? null,
        $m['qa_reviewed_by'] ?? null,
        $m['workflow']['qa_claim']['email'] ?? null,
    ] as $rawEmail) {
        $email = fm_norm_email($rawEmail);
        if ($email !== '') $qaEmails[$email] = true;
    }

    $techEvents = [
        'correction_submitted' => true,
        'submitted_for_qa' => true,
        'claimed_correction' => true,
        'claimed_new' => true,
        'reopened_project_claimed' => true,
        'assigned_current' => true,
        'correction_target' => true,
    ];
    $history = fm_manifest_work_history($m);
    for ($i = count($history) - 1; $i >= 0; $i--) {
        $event = fm_as_array($history[$i] ?? []);
        $eventName = strtolower(trim((string)($event['event'] ?? ($event['type'] ?? ''))));
        if ($eventName === '' || !isset($techEvents[$eventName])) continue;

        $email = fm_norm_email($event['worker_email'] ?? ($event['assigned_to_email'] ?? ($event['email'] ?? '')));
        $name = fm_norm_string($event['worker_name'] ?? ($event['assigned_to_name'] ?? ($event['name'] ?? '')));
        if ($email !== '' && isset($qaEmails[$email])) continue;
        if ($email !== '' || $name !== '') {
            return [
                'email' => $email,
                'name' => $name !== '' ? $name : $email,
                'basis' => $eventName,
                'at' => $event['ts'] ?? ($event['at'] ?? ($event['date'] ?? null)),
            ];
        }
    }

    if ($techHistory === null) $techHistory = fm_manifest_technician_history($m);
    $historyEntries = array_values(array_filter(fm_as_array($techHistory), 'is_array'));
    for ($i = count($historyEntries) - 1; $i >= 0; $i--) {
        $entry = $historyEntries[$i];
        $email = fm_norm_email($entry['email'] ?? '');
        $name = fm_norm_string($entry['name'] ?? '');
        if ($email !== '' && isset($qaEmails[$email])) continue;
        if ($email !== '' || $name !== '') {
            return [
                'email' => $email,
                'name' => $name !== '' ? $name : $email,
                'basis' => (string)($entry['last_event'] ?? 'technician_history'),
                'at' => $entry['last_ts'] ?? null,
            ];
        }
    }

    foreach ([
        ['email' => 'latest_technician_email', 'name' => 'latest_technician_name', 'basis' => 'latest_technician'],
        ['email' => 'display_technician_email', 'name' => 'display_technician_name', 'basis' => 'display_technician'],
        ['email' => 'assigned_to_email', 'name' => 'assigned_to_name', 'basis' => 'assigned_to'],
        ['email' => 'technician_email', 'name' => 'technician_name', 'basis' => 'technician'],
        ['email' => 'drafter_email', 'name' => 'drafter_name', 'basis' => 'drafter'],
    ] as $pair) {
        $email = fm_norm_email($m[$pair['email']] ?? '');
        $name = fm_norm_string($m[$pair['name']] ?? '');
        if ($email !== '' && isset($qaEmails[$email])) continue;
        if ($email !== '' || $name !== '') {
            return [
                'email' => $email,
                'name' => $name !== '' ? $name : $email,
                'basis' => $pair['basis'],
                'at' => null,
            ];
        }
    }

    return null;
}

function fm_legacy_manifest($manifest) {
    $m = fm_as_array($manifest);
    $workflow = fm_extract_workflow($m);
    $timestamps = fm_as_array($m['timestamps'] ?? []);
    $ownerRef = fm_as_array($m['owner_ref'] ?? []);
    $orgRef = fm_as_array($m['organization_ref'] ?? []);
    $teamRef = fm_as_array($m['team_ref'] ?? []);
    $audit = fm_as_array($m['audit'] ?? []);
    $delivery = fm_as_array($m['delivery'] ?? []);

    $assigned = fm_as_array($workflow['assigned_to'] ?? []);
    $reserved = fm_as_array($workflow['reserved_to'] ?? []);
    $correction = fm_as_array($workflow['correction_to'] ?? []);
    $qaClaim = fm_as_array($workflow['qa_claim'] ?? []);

    $legacy = $m;
    $legacy['is_vip'] = !empty($m['is_vip']);
    $legacy['is_expedited'] = !empty($m['is_expedited']);
    $legacy['owner_email'] = fm_first_nonblank($m['owner_email'] ?? null, $ownerRef['email'] ?? null);
    $legacy['owner_name'] = fm_first_nonblank($m['owner_name'] ?? null, $ownerRef['name'] ?? null);
    $legacy['organization_id'] = fm_first_nonblank($m['organization_id'] ?? null, $orgRef['id'] ?? null);
    $legacy['team_id'] = fm_first_nonblank($m['team_id'] ?? null, $teamRef['id'] ?? null);
    $legacy['created_at'] = fm_first_nonblank($m['created_at'] ?? null, $timestamps['created_at'] ?? null);
    $legacy['queued_at'] = fm_first_nonblank($m['queued_at'] ?? null, $timestamps['queued_at'] ?? null);
    $legacy['processed_at'] = fm_first_nonblank($m['processed_at'] ?? null, $timestamps['processed_at'] ?? null);
    $legacy['started_at'] = fm_first_nonblank($m['started_at'] ?? null, $timestamps['started_at'] ?? null);
    $legacy['uploaded_at'] = fm_first_nonblank($m['uploaded_at'] ?? null, $timestamps['uploaded_at'] ?? null);
    $legacy['completed_at'] = fm_first_nonblank($m['completed_at'] ?? null, $timestamps['completed_at'] ?? null);
    $legacy['rejected_at'] = fm_first_nonblank($m['rejected_at'] ?? null, $timestamps['rejected_at'] ?? null);
    $legacy['updated_at'] = fm_first_nonblank($m['updated_at'] ?? null, $timestamps['updated_at'] ?? null);
    $legacy['assigned_to_email'] = fm_first_nonblank($m['assigned_to_email'] ?? null, $assigned['email'] ?? null);
    $legacy['assigned_to_name'] = fm_first_nonblank($m['assigned_to_name'] ?? null, $assigned['name'] ?? null);
    $legacy['assigned_at'] = $m['assigned_at'] ?? ($workflow['assigned_at'] ?? null);
    $legacy['reserved_to_email'] = fm_first_nonblank($m['reserved_to_email'] ?? null, $reserved['email'] ?? null);
    $legacy['reserved_to_name'] = fm_first_nonblank($m['reserved_to_name'] ?? null, $reserved['name'] ?? null);
    $legacy['reserved_at'] = $m['reserved_at'] ?? ($workflow['reserved_at'] ?? null);
    $legacy['correction_to_email'] = fm_first_nonblank($m['correction_to_email'] ?? null, $correction['email'] ?? null);
    $legacy['correction_to_name'] = fm_first_nonblank($m['correction_to_name'] ?? null, $correction['name'] ?? null);
    $legacy['qa_claimed_by_email'] = fm_first_nonblank($m['qa_claimed_by_email'] ?? null, $qaClaim['email'] ?? null);
    $legacy['qa_claimed_by_name'] = fm_first_nonblank($m['qa_claimed_by_name'] ?? null, $qaClaim['name'] ?? null);
    $legacy['qa_claimed_at'] = $m['qa_claimed_at'] ?? ($qaClaim['claimed_at'] ?? null);
    $legacy['qa_history'] = $m['qa_history'] ?? ($workflow['qa_history'] ?? []);
    $legacy['work_history'] = $m['work_history'] ?? ($workflow['history'] ?? []);
    $legacy['manager_audit_status'] = $m['manager_audit_status'] ?? ($audit['manager_audit_status'] ?? null);
    $legacy['manager_audit_note'] = $m['manager_audit_note'] ?? ($audit['manager_audit_note'] ?? null);
    $legacy['manager_audit_annotations'] = $m['manager_audit_annotations'] ?? ($audit['manager_audit_annotations'] ?? null);
    $legacy['email_state'] = $m['email_state'] ?? ($delivery['email_state'] ?? []);
    $legacy['email_events'] = $m['email_events'] ?? ($delivery['email_events'] ?? []);
    $legacy['has_report_pdf'] = !empty(fm_as_array($m['artifacts'] ?? [])['has_report_pdf']);
    $legacy['has_summary_pdf'] = !empty(fm_as_array($m['artifacts'] ?? [])['has_summary_pdf']);

    $techHistory = fm_manifest_technician_history($legacy);
    $originalTech = fm_pick_technician_entry($techHistory, 'original');
    $latestTech = fm_pick_technician_entry($techHistory, 'latest');
    $status = strtolower(trim((string)($legacy['status'] ?? '')));

    $legacy['technician_history'] = $techHistory;
    $legacy['original_technician_email'] = (string)($originalTech['email'] ?? '');
    $legacy['original_technician_name'] = (string)($originalTech['name'] ?? '');
    $legacy['latest_technician_email'] = (string)($latestTech['email'] ?? '');
    $legacy['latest_technician_name'] = (string)($latestTech['name'] ?? '');
    $legacy['display_technician_email'] = $legacy['assigned_to_email'] ?: ($legacy['latest_technician_email'] ?: $legacy['original_technician_email']);
    $legacy['display_technician_name'] = $legacy['assigned_to_name'] ?: ($legacy['latest_technician_name'] ?: $legacy['original_technician_name']);

    $payTech = fm_project_pay_technician_from_manifest($legacy, $techHistory);
    if (is_array($payTech) && (trim((string)($payTech['email'] ?? '')) !== '' || trim((string)($payTech['name'] ?? '')) !== '')) {
        $legacy['qa_paid_to_email'] = (string)($payTech['email'] ?? '');
        $legacy['qa_paid_to_name'] = (string)($payTech['name'] ?? ($payTech['email'] ?? ''));
        $legacy['technician_pay_to_email'] = $legacy['qa_paid_to_email'];
        $legacy['technician_pay_to_name'] = $legacy['qa_paid_to_name'];
        $legacy['technician_pay_basis'] = (string)($payTech['basis'] ?? 'latest_technician_touch');
        $legacy['technician_pay_basis_at'] = $payTech['at'] ?? null;
    }

    if (in_array($status, ['correction_needed', 'requeue'], true)) {
        if (trim((string)$legacy['correction_to_email']) === '' && trim((string)$legacy['latest_technician_email']) !== '') {
            $legacy['correction_to_email'] = $legacy['latest_technician_email'];
        }
        if (trim((string)$legacy['correction_to_name']) === '' && trim((string)$legacy['latest_technician_name']) !== '') {
            $legacy['correction_to_name'] = $legacy['latest_technician_name'];
        }
    }

    return $legacy;
}

function fm_project_asset_url($projectId, $fileName) {
    return rtrim(fm_api_base_url(), '/') . '/projects/' . rawurlencode((string)$projectId) . '/artifacts/' . rawurlencode((string)$fileName);
}

function fm_project_pdf_url($projectId, $slot = 'main') {
    return rtrim(fm_api_base_url(), '/') . '/projects/' . rawurlencode((string)$projectId) . '/pdf?slot=' . rawurlencode((string)$slot);
}

function fm_project_doc_url($projectId, $doc) {
    $doc = trim((string)$doc);
    if ($doc === 'pdf_state') {
        return rtrim(fm_api_base_url(), '/') . '/projects/' . rawurlencode((string)$projectId) . '/editor/pdf-state';
    }
    $map = [
        'app_metadata' => 'app-metadata',
        'branding_defaults' => 'branding-defaults',
        'pdf_state_wrapped' => 'pdf-state',
    ];
    $target = $map[$doc] ?? $doc;
    return rtrim(fm_api_base_url(), '/') . '/projects/' . rawurlencode((string)$projectId) . '/' . rawurlencode((string)$target);
}

function fm_build_assets_map($projectId, $files) {
    $assets = [];
    foreach (fm_as_array($files) as $file) {
        $name = (string)($file['name'] ?? '');
        if ($name === '') continue;
        $base = strtolower(pathinfo($name, PATHINFO_FILENAME));
        $assets[$base] = fm_project_asset_url($projectId, $name);
    }
    return $assets;
}

function fm_project_organization_context($manifest) {
    $manifest = fm_as_array($manifest);
    $organization = null;
    $orgId = fm_norm_string($manifest['organization_id'] ?? '');
    if ($orgId !== '' && function_exists('orgRead')) {
        $org = orgRead($orgId);
        if (is_array($org)) {
            $organization = [
                'id' => $orgId,
                'name' => $org['name'] ?? '',
                'branding' => $org['branding'] ?? null,
                'report_settings' => $org['report_settings'] ?? []
            ];
        }
    }
    return $organization;
}

function fm_current_actor() {
    $email = fm_norm_email($_SESSION['user_email'] ?? '');
    $name = fm_norm_string($_SESSION['user_name'] ?? '');
    $actor = ['email' => $email];
    if ($name !== '') $actor['name'] = $name;
    $roles = [];

    if ($email !== '' && function_exists('readUserDataByEmail')) {
        $u = readUserDataByEmail($email);
        if (is_array($u)) {
            if ($name === '' && !empty($u['name'])) $actor['name'] = (string)$u['name'];
            if (!empty($u['id'])) $actor['id'] = (string)$u['id'];
            if (!empty($u['team_id'])) $actor['team_id'] = (string)$u['team_id'];
            if (!empty($u['organization_id'])) $actor['organization_id'] = (string)$u['organization_id'];
            if (!empty($u['drafter_rank'])) $actor['drafter_rank'] = (string)$u['drafter_rank'];
            if (!empty($u['role'])) $roles[] = (string)$u['role'];
            if (!empty($u['is_admin'])) $roles[] = 'admin';
        }
    }
    if (function_exists('isAdmin') && isAdmin()) $roles[] = 'admin';
    if (!empty($roles)) $actor['roles'] = array_values(array_unique($roles));

    return $actor;
}

function fm_fetch_project_detail($projectId) {
    $res = fm_api_json('GET', 'projects/' . rawurlencode((string)$projectId));
    if (!$res['ok'] || !is_array($res['json'])) return null;
    return $res['json']['project'] ?? null;
}

function fm_fetch_project_manifest($projectId) {
    $detail = fm_fetch_project_detail($projectId);
    if (!is_array($detail)) return null;
    return fm_legacy_manifest($detail['manifest'] ?? []);
}

function fm_fetch_project_docs($projectId) {
    $app = fm_api_json('GET', 'projects/' . rawurlencode((string)$projectId) . '/app-metadata');
    $pdf = fm_api_json('GET', 'projects/' . rawurlencode((string)$projectId) . '/pdf-state');
    return [
        'app_metadata' => (is_array($app['json']) && array_key_exists('value', $app['json'])) ? $app['json']['value'] : [],
        'pdf_state' => (is_array($pdf['json']) && array_key_exists('value', $pdf['json'])) ? $pdf['json']['value'] : null,
    ];
}

function fm_fetch_project_files($projectId) {
    $res = fm_api_json('GET', 'projects/' . rawurlencode((string)$projectId) . '/artifacts');
    if (!$res['ok'] || !is_array($res['json'])) return [];
    return fm_as_array($res['json']['files'] ?? []);
}

function fm_fetch_project_bundle($projectId) {
    $res = fm_api_json('GET', 'projects/' . rawurlencode((string)$projectId) . '/editor');
    if (!$res['ok'] || !is_array($res['json'])) return null;

    $bundle = $res['json'];
    $manifest = fm_legacy_manifest($bundle['manifest'] ?? []);
    $bundle['manifest'] = $manifest;
    if (empty($bundle['organization'])) {
        $bundle['organization'] = fm_project_organization_context($manifest);
    }
    $bundle['app_metadata'] = fm_as_array($bundle['app_metadata'] ?? []);
    $bundle['assets'] = fm_as_array($bundle['assets'] ?? []);
    $bundle['files'] = fm_as_array($bundle['files'] ?? []);
    $bundle['pdf_state_asset'] = $bundle['pdf_state_asset'] ?? fm_project_doc_url($projectId, 'pdf_state');

    return $bundle;
}

function fm_fetch_all_projects($fresh = false) {
    static $cache = null;
    if (!$fresh && is_array($cache)) return $cache;
    $res = fm_api_json('GET', 'projects', null, [
        'include_all' => 1,
        'limit' => 5000
    ]);
    if (!$res['ok'] || !is_array($res['json'])) {
        $cache = [];
        return $cache;
    }
    $projects = [];
    foreach (fm_as_array($res['json']['projects'] ?? []) as $manifest) {
        $projects[] = fm_legacy_manifest($manifest);
    }
    $cache = $projects;
    return $cache;
}

function fm_find_project_by_address($address) {
    $needle = strtolower(trim((string)$address));
    if ($needle === '') return null;
    foreach (fm_fetch_all_projects() as $project) {
        $candidate = strtolower(trim((string)($project['address'] ?? '')));
        if ($candidate !== '' && $candidate === $needle) return $project;
    }
    return null;
}

function fm_project_patch($projectId, $patch) {
    $res = fm_api_json('PATCH', 'projects/' . rawurlencode((string)$projectId), is_array($patch) ? $patch : []);
    if (!$res['ok'] || !is_array($res['json'])) return null;
    $project = fm_as_array($res['json']['project'] ?? []);
    return fm_legacy_manifest($project['manifest'] ?? []);
}

function fm_latest_reopen_context($manifest) {
    $m = fm_as_array($manifest);
    $resubmissions = array_values(array_filter(fm_as_array($m['resubmissions'] ?? []), 'is_array'));
    if (empty($resubmissions)) return null;

    $bestIndex = count($resubmissions) - 1;
    $bestTs = null;
    foreach ($resubmissions as $idx => $entry) {
        $ts = fm_ts_value($entry['reopened_at'] ?? ($entry['resubmitted_at'] ?? null));
        if ($ts !== null && ($bestTs === null || $ts >= $bestTs)) {
            $bestTs = $ts;
            $bestIndex = $idx;
        }
    }

    $entry = fm_as_array($resubmissions[$bestIndex] ?? []);
    $round = (int)($entry['round'] ?? ($bestIndex + 1));
    if ($round < 1) $round = $bestIndex + 1;
    $reopenedAt = $entry['reopened_at'] ?? ($entry['resubmitted_at'] ?? ($m['resubmitted_at'] ?? null));
    $reopenedTs = fm_ts_value($reopenedAt);

    return [
        'index' => $bestIndex,
        'round' => $round,
        'entry' => $entry,
        'reopened_at' => $reopenedAt,
        'reopened_ts' => $reopenedTs,
        'resubmissions' => $resubmissions,
    ];
}

function fm_claim_candidate_ts($candidate, $reopenedTs) {
    $ts = fm_ts_value($candidate);
    if ($ts === null) return null;
    if ($reopenedTs !== null && $ts < $reopenedTs) return null;
    return $ts;
}

function fm_current_reopen_claim_record($manifest, $context, $source = 'unknown') {
    $m = fm_as_array($manifest);
    $workflow = fm_extract_workflow($m);
    $assigned = fm_as_array($workflow['assigned_to'] ?? []);
    $reopenedTs = $context['reopened_ts'] ?? null;

    $email = fm_norm_email($m['assigned_to_email'] ?? ($assigned['email'] ?? ''));
    $name = fm_norm_string($m['assigned_to_name'] ?? ($assigned['name'] ?? ''));
    $claimTs = null;
    $claimRaw = null;
    $candidates = [
        $m['claimed_at'] ?? null,
        $m['technician_claimed_at'] ?? null,
        $m['assigned_at'] ?? null,
        $workflow['claimed_at'] ?? null,
        $workflow['assigned_at'] ?? null,
        $assigned['claimed_at'] ?? null,
        $assigned['assigned_at'] ?? null,
        $m['started_at'] ?? null,
        $workflow['started_at'] ?? null,
    ];

    foreach ($candidates as $candidate) {
        $ts = fm_claim_candidate_ts($candidate, $reopenedTs);
        if ($ts !== null && ($claimTs === null || $ts < $claimTs)) {
            $claimTs = $ts;
            $claimRaw = $candidate;
        }
    }

    foreach ([fm_manifest_work_history($m), fm_as_array($workflow['history'] ?? [])] as $history) {
        foreach ($history as $event) {
            $event = fm_as_array($event);
            if (!$event) continue;
            $eventName = strtolower(trim((string)($event['event'] ?? ($event['type'] ?? ''))));
            if (strpos($eventName, 'claim') === false && strpos($eventName, 'assign') === false) continue;
            $raw = $event['ts'] ?? ($event['at'] ?? ($event['created_at'] ?? ($event['assigned_at'] ?? ($event['claimed_at'] ?? null))));
            $ts = fm_claim_candidate_ts($raw, $reopenedTs);
            $eventEmail = fm_norm_email($event['worker_email'] ?? ($event['assigned_to_email'] ?? ($event['email'] ?? '')));
            $eventNameValue = fm_norm_string($event['worker_name'] ?? ($event['assigned_to_name'] ?? ($event['name'] ?? '')));
            $fillsIdentity = ($email === '' && $eventEmail !== '') || ($name === '' && $eventNameValue !== '');
            if ($ts === null || ($claimTs !== null && $ts > $claimTs) || ($claimTs !== null && $ts === $claimTs && !$fillsIdentity)) continue;
            if ($claimTs === null || $ts < $claimTs) {
                $claimTs = $ts;
                $claimRaw = $raw;
            }
            if ($eventEmail !== '') $email = $eventEmail;
            if ($eventNameValue !== '') $name = $eventNameValue;
        }
    }

    if ($claimTs === null || ($email === '' && $name === '')) return null;

    return [
        'round' => (int)($context['round'] ?? 1),
        'claimed_at' => is_string($claimRaw) && trim($claimRaw) !== '' ? trim($claimRaw) : gmdate('c', $claimTs),
        'claimed_by_email' => $email,
        'claimed_by_name' => $name,
        'source' => (string)$source,
        'recorded_at' => gmdate('c'),
    ];
}

function fm_reopen_claim_record_exists($claims, $record) {
    $round = (int)($record['round'] ?? 0);
    $email = fm_norm_email($record['claimed_by_email'] ?? '');
    $name = strtolower(fm_norm_string($record['claimed_by_name'] ?? ''));
    foreach (fm_as_array($claims) as $claim) {
        $claim = fm_as_array($claim);
        if ((int)($claim['round'] ?? 0) !== $round) continue;
        $claimEmail = fm_norm_email($claim['claimed_by_email'] ?? '');
        $claimName = strtolower(fm_norm_string($claim['claimed_by_name'] ?? ''));
        if ($email !== '' && $claimEmail === $email) return true;
        if ($email === '' && $name !== '' && $claimName === $name) return true;
    }
    return false;
}

function fm_project_record_reopen_claim($projectId, $source = 'unknown') {
    $projectId = trim((string)$projectId);
    if ($projectId === '') return ['success' => false, 'error' => 'Missing project id'];

    $manifest = fm_fetch_project_manifest($projectId);
    if (!is_array($manifest)) return ['success' => false, 'error' => 'Project not found'];

    $context = fm_latest_reopen_context($manifest);
    if (!$context) {
        return ['success' => true, 'recorded' => false, 'reason' => 'not_reopened', 'project' => $manifest];
    }

    $record = fm_current_reopen_claim_record($manifest, $context, $source);
    if (!$record) {
        return ['success' => true, 'recorded' => false, 'reason' => 'no_post_reopen_claim', 'project' => $manifest];
    }

    $claims = array_values(array_filter(fm_as_array($manifest['resubmission_claims'] ?? []), 'is_array'));
    $resubmissions = $context['resubmissions'];
    $entryIndex = (int)$context['index'];
    $entry = fm_as_array($resubmissions[$entryIndex] ?? []);
    $entryClaims = array_values(array_filter(fm_as_array($entry['claims'] ?? []), 'is_array'));
    $topExists = fm_reopen_claim_record_exists($claims, $record);
    $entryExists = fm_reopen_claim_record_exists($entryClaims, $record);

    if (!$topExists) $claims[] = $record;
    if (!$entryExists) {
        $entryClaims[] = $record;
        $entry['claims'] = $entryClaims;
    }
    $entry['claimed_at'] = $record['claimed_at'];
    $entry['claimed_by_email'] = $record['claimed_by_email'];
    $entry['claimed_by_name'] = $record['claimed_by_name'];
    $resubmissions[$entryIndex] = $entry;

    if ($topExists && $entryExists) {
        return ['success' => true, 'recorded' => false, 'reason' => 'already_recorded', 'claim' => $record, 'project' => $manifest];
    }

    $updated = fm_project_patch($projectId, [
        'resubmission_claims' => $claims,
        'resubmissions' => $resubmissions,
        'last_reopened_round' => $record['round'],
        'last_reopened_claimed_at' => $record['claimed_at'],
        'last_reopened_claimed_by_email' => $record['claimed_by_email'],
        'last_reopened_claimed_by_name' => $record['claimed_by_name'],
        'reopen_claim_tracking_updated_at' => gmdate('c'),
    ]);

    if (!is_array($updated)) {
        return ['success' => false, 'error' => 'Failed to save reopen claim tracking', 'claim' => $record];
    }

    return ['success' => true, 'recorded' => true, 'claim' => $record, 'project' => $updated];
}

function fm_project_set_status($projectId, $status) {
    $body = ['status' => (string)$status, 'actor' => fm_current_actor()];
    $res = fm_api_json('POST', 'projects/' . rawurlencode((string)$projectId) . '/status', $body);
    if (!$res['ok'] || !is_array($res['json'])) return null;
    return fm_legacy_manifest($res['json']['project'] ?? []);
}

function fm_rush_current() {
    $res = fm_api_request('GET', 'rush/current', ['timeout' => 5]);
    if (!$res['ok'] || !is_array($res['json'])) {
        return ['success' => false, 'active' => false, 'rush_mode' => null, 'error' => $res['error'] ?: 'Rush mode status unavailable'];
    }
    $json = $res['json'];
    return [
        'success' => true,
        'ok' => true,
        'active' => !empty($json['active']),
        'rush_mode' => is_array($json['rush_mode'] ?? null) ? $json['rush_mode'] : null,
    ];
}

function fm_rush_admin_list() {
    $res = fm_api_json('POST', 'admin/rush-modes/list', ['actor' => fm_current_actor()]);
    if (!$res['ok'] || !is_array($res['json'])) {
        return ['success' => false, 'rush_modes' => [], 'error' => $res['error'] ?: 'Rush mode history unavailable'];
    }
    return [
        'success' => !isset($res['json']['success']) || !empty($res['json']['success']),
        'rush_modes' => fm_as_array($res['json']['rush_modes'] ?? []),
        'error' => $res['json']['error'] ?? null,
    ];
}

function fm_rush_admin_start($startAt, $durationMinutes) {
    $payload = [
        'actor' => fm_current_actor(),
        'duration_minutes' => (int)$durationMinutes,
    ];
    $startAt = trim((string)$startAt);
    if ($startAt !== '') $payload['start_at'] = $startAt;
    $res = fm_api_json('POST', 'admin/rush-modes', $payload);
    if (!$res['ok'] || !is_array($res['json'])) {
        return ['success' => false, 'error' => $res['error'] ?: 'Failed to start rush mode'];
    }
    return [
        'success' => !isset($res['json']['success']) || !empty($res['json']['success']),
        'rush_mode' => is_array($res['json']['rush_mode'] ?? null) ? $res['json']['rush_mode'] : null,
        'current' => is_array($res['json']['current'] ?? null) ? $res['json']['current'] : null,
        'error' => $res['json']['error'] ?? null,
    ];
}

function fm_rush_automation_get() {
    $res = fm_api_json('POST', 'admin/rush-modes/automation', ['actor' => fm_current_actor()]);
    if (!$res['ok'] || !is_array($res['json'])) {
        return ['success' => false, 'settings' => null, 'last_evaluation' => null, 'error' => $res['error'] ?: 'Rush mode automation settings unavailable'];
    }
    return [
        'success' => !isset($res['json']['success']) || !empty($res['json']['success']),
        'settings' => is_array($res['json']['settings'] ?? null) ? $res['json']['settings'] : null,
        'last_evaluation' => is_array($res['json']['last_evaluation'] ?? null) ? $res['json']['last_evaluation'] : null,
        'error' => $res['json']['error'] ?? null,
    ];
}

function fm_rush_automation_set($settings) {
    $settings = is_array($settings) ? $settings : [];
    $res = fm_api_json('POST', 'admin/rush-modes/automation/update', [
        'actor' => fm_current_actor(),
        'settings' => $settings,
    ]);
    if (!$res['ok'] || !is_array($res['json'])) {
        return ['success' => false, 'settings' => null, 'last_evaluation' => null, 'error' => $res['error'] ?: 'Failed to save rush mode automation settings'];
    }
    return [
        'success' => !isset($res['json']['success']) || !empty($res['json']['success']),
        'settings' => is_array($res['json']['settings'] ?? null) ? $res['json']['settings'] : null,
        'last_evaluation' => is_array($res['json']['last_evaluation'] ?? null) ? $res['json']['last_evaluation'] : null,
        'error' => $res['json']['error'] ?? null,
    ];
}

function fm_node_reindex_projects() {
    $res = fm_api_json('POST', 'admin/reindex', ['actor' => fm_current_actor()], null);
    if (!$res['ok'] || !is_array($res['json'])) {
        return [
            'success' => false,
            'ok' => false,
            'error' => $res['error'] ?: 'Failed to rebuild FirstMeasure project index',
        ];
    }

    $json = $res['json'];
    $result = fm_as_array($json['result'] ?? []);
    $status = fm_as_array($json['firstmeasure'] ?? []);
    $count = (int)($result['indexedProjects'] ?? $status['indexedProjects'] ?? 0);

    return [
        'success' => !isset($json['ok']) || !empty($json['ok']),
        'ok' => !isset($json['ok']) || !empty($json['ok']),
        'count' => $count,
        'bad' => 0,
        'indexed_projects' => $count,
        'db_path' => $result['dbPath'] ?? ($status['dbPath'] ?? null),
        'started_at' => $result['startedAt'] ?? null,
        'finished_at' => $result['finishedAt'] ?? null,
        'firstmeasure' => $status,
        'error' => $json['error'] ?? null,
    ];
}

function fm_project_put_doc($projectId, $doc, $value) {
    $res = fm_api_json('PUT', 'projects/' . rawurlencode((string)$projectId) . '/' . ltrim((string)$doc, '/'), $value);
    return $res['ok'];
}

function fm_project_upload_file($projectId, $filePath, $fileName = null, $mimeType = null) {
    $filePath = (string)$filePath;
    if ($filePath === '' || !file_exists($filePath)) return false;
    $name = $fileName ?: basename($filePath);
    $mime = $mimeType ?: 'application/octet-stream';
    $res = fm_api_request('POST', 'projects/' . rawurlencode((string)$projectId) . '/artifacts', [
        'multipart' => [
            'file' => [
                'path' => $filePath,
                'name' => $name,
                'type' => $mime
            ]
        ]
    ]);
    return $res['ok'];
}

function fm_project_upload_text($projectId, $fileName, $text, $contentType = 'text/plain') {
    $res = fm_api_json('POST', 'projects/' . rawurlencode((string)$projectId) . '/artifacts', [
        'file_name' => (string)$fileName,
        'content_text' => (string)$text,
        'content_type' => (string)$contentType
    ]);
    return $res['ok'];
}

function fm_project_create($payload) {
    $res = fm_api_json('POST', 'projects', is_array($payload) ? $payload : []);
    if (!$res['ok'] || !is_array($res['json'])) return null;
    return $res['json']['project'] ?? null;
}

function fm_project_query($payload) {
    $res = fm_api_json('POST', 'projects/query', is_array($payload) ? $payload : []);
    if (!$res['ok'] || !is_array($res['json'])) return [];
    $items = [];
    foreach (fm_as_array($res['json']['projects'] ?? []) as $manifest) {
        $items[] = fm_legacy_manifest($manifest);
    }
    return $items;
}

function fm_project_list($payload) {
    $res = fm_api_json('POST', 'projects/list', is_array($payload) ? $payload : []);
    if (!$res['ok'] || !is_array($res['json'])) {
        return [
            'ok' => false,
            'projects' => [],
            'pagination' => [],
        ];
    }
    return [
        'ok' => true,
        'projects' => fm_as_array($res['json']['projects'] ?? []),
        'pagination' => fm_as_array($res['json']['pagination'] ?? []),
    ];
}

function fm_queue_counts($payload = []) {
    $res = fm_api_json('POST', 'queue/counts', is_array($payload) ? $payload : []);
    if (!$res['ok'] || !is_array($res['json'])) {
        return [
            'ok' => false,
            'counts' => [],
            'total_count' => 0,
            'version' => 0,
        ];
    }
    return [
        'ok' => true,
        'counts' => fm_as_array($res['json']['counts'] ?? []),
        'total_count' => (int)($res['json']['total_count'] ?? 0),
        'version' => (int)($res['json']['version'] ?? 0),
    ];
}

function fm_queue_bucket($payload = []) {
    $res = fm_api_json('POST', 'queue/bucket', is_array($payload) ? $payload : []);
    if (!$res['ok'] || !is_array($res['json'])) {
        return [
            'ok' => false,
            'projects' => [],
            'pagination' => [],
        ];
    }
    return [
        'ok' => true,
        'projects' => fm_as_array($res['json']['projects'] ?? []),
        'pagination' => fm_as_array($res['json']['pagination'] ?? []),
    ];
}

function fm_fetch_all_project_rows($payload = []) {
    $basePayload = is_array($payload) ? $payload : [];
    if (!isset($basePayload['filter'])) $basePayload['filter'] = 'all';
    if (!isset($basePayload['status_filter'])) $basePayload['status_filter'] = 'all';
    if (!array_key_exists('include_all', $basePayload)) $basePayload['include_all'] = true;

    $limit = (int)($basePayload['limit'] ?? 200);
    if ($limit < 1) $limit = 200;
    if ($limit > 200) $limit = 200;
    $basePayload['limit'] = $limit;

    $rows = [];
    $seen = [];
    $page = 1;
    $totalPages = 1;
    $maxPages = 250;
    $hadSuccessfulPage = false;

    while ($page <= $totalPages && $page <= $maxPages) {
        $pagePayload = $basePayload;
        $pagePayload['page'] = $page;

        $result = fm_project_list($pagePayload);
        if (empty($result['ok'])) {
            return $hadSuccessfulPage ? $rows : null;
        }
        $hadSuccessfulPage = true;
        $batch = fm_as_array($result['projects'] ?? []);
        foreach ($batch as $project) {
            if (!is_array($project)) continue;
            $projectId = strtolower(trim((string)($project['id'] ?? $project['folder'] ?? '')));
            if ($projectId !== '') {
                if (isset($seen[$projectId])) continue;
                $seen[$projectId] = true;
            }
            $rows[] = $project;
        }

        $pagination = fm_as_array($result['pagination'] ?? []);
        $reportedTotalPages = (int)($pagination['total_pages'] ?? 0);
        if ($reportedTotalPages > 0) {
            $totalPages = $reportedTotalPages;
        } else {
            $reportedTotalCount = (int)($pagination['total_count'] ?? 0);
            $totalPages = $reportedTotalCount > 0 ? (int)ceil($reportedTotalCount / $limit) : $page;
        }

        if (!$batch || $page >= $totalPages) break;
        $page++;
    }

    return $rows;
}

function fm_for_each_project_row($payload, $callback) {
    $basePayload = is_array($payload) ? $payload : [];
    if (!isset($basePayload['filter'])) $basePayload['filter'] = 'all';
    if (!isset($basePayload['status_filter'])) $basePayload['status_filter'] = 'all';
    if (!array_key_exists('include_all', $basePayload)) $basePayload['include_all'] = true;

    $limit = (int)($basePayload['limit'] ?? 250);
    if ($limit < 1) $limit = 250;
    if ($limit > 250) $limit = 250;
    $basePayload['limit'] = $limit;

    $seen = [];
    $page = 1;
    $totalPages = 1;
    $maxPages = 500;
    $hadSuccessfulPage = false;

    while ($page <= $totalPages && $page <= $maxPages) {
        $pagePayload = $basePayload;
        $pagePayload['page'] = $page;

        $result = fm_project_list($pagePayload);
        if (empty($result['ok'])) {
            return $hadSuccessfulPage;
        }
        $hadSuccessfulPage = true;
        $batch = fm_as_array($result['projects'] ?? []);

        foreach ($batch as $project) {
            if (!is_array($project)) continue;
            $projectId = strtolower(trim((string)($project['id'] ?? $project['folder'] ?? '')));
            if ($projectId !== '') {
                if (isset($seen[$projectId])) continue;
                $seen[$projectId] = true;
            }
            if (call_user_func($callback, $project) === false) {
                return true;
            }
        }

        $pagination = fm_as_array($result['pagination'] ?? []);
        $reportedTotalPages = (int)($pagination['total_pages'] ?? 0);
        if ($reportedTotalPages > 0) {
            $totalPages = $reportedTotalPages;
        } else {
            $reportedTotalCount = (int)($pagination['total_count'] ?? 0);
            $totalPages = $reportedTotalCount > 0 ? (int)ceil($reportedTotalCount / $limit) : $page;
        }

        unset($result, $batch, $pagePayload);
        if (function_exists('gc_collect_cycles')) @gc_collect_cycles();

        if ($page >= $totalPages) break;
        $page++;
    }

    return $hadSuccessfulPage;
}

function fm_queue_status($queueMode = null) {
    $payload = ['actor' => fm_current_actor()];
    if ($queueMode !== null && $queueMode !== '') $payload['queue_mode'] = $queueMode;
    return fm_api_json('POST', 'queue/status', $payload);
}

function fm_queue_claim_next($queueMode = null, $extra = []) {
    $payload = array_merge([
        'actor' => fm_current_actor()
    ], is_array($extra) ? $extra : []);
    if ($queueMode !== null && $queueMode !== '') $payload['queue_mode'] = $queueMode;
    return fm_api_json('POST', 'queue/claim-next', $payload);
}

function fm_queue_overview($payload = []) {
    return fm_api_json('POST', 'queue/admin/overview', is_array($payload) ? $payload : []);
}

function manifestEnsureEmailTracking(&$m) {
    if (!is_array($m)) $m = [];
    if (!isset($m['email_state']) || !is_array($m['email_state'])) $m['email_state'] = [];
    if (!isset($m['email_events']) || !is_array($m['email_events'])) $m['email_events'] = [];
}

function manifestLogEmailEvent(&$m, $type, $to, $subject, $ret, $meta = []) {
    manifestEnsureEmailTracking($m);
    $ok = !empty($ret['ok']);
    $http = $ret['http'] ?? null;
    $postmark = $ret['postmark'] ?? null;
    $ev = [
        'ts_utc' => gmdate('c'),
        'type' => (string)$type,
        'to' => (string)$to,
        'subject' => (string)$subject,
        'ok' => $ok,
        'http' => $http,
        'meta' => is_array($meta) ? $meta : [],
        'postmark' => $postmark,
    ];
    $m['email_events'][] = $ev;
    $st = $m['email_state'][$type] ?? [];
    if (!is_array($st)) $st = [];
    $st['type'] = (string)$type;
    $st['last_attempt_utc'] = $ev['ts_utc'];
    $st['last_ok'] = $ok;
    $st['last_http'] = $http;
    $st['last_to'] = (string)$to;
    $st['last_subject'] = (string)$subject;
    $st['attempts'] = (int)($st['attempts'] ?? 0) + 1;
    if ($ok) {
        $st['sent_ok'] = true;
        $st['sent_at_utc'] = $ev['ts_utc'];
        if (is_array($postmark) && !empty($postmark['MessageID'])) {
            $st['message_id'] = $postmark['MessageID'];
        }
    }
    if (count($m['email_events']) > 200) {
        $m['email_events'] = array_slice($m['email_events'], -200);
    }
    $m['email_state'][$type] = $st;
}

function projectGetEmailSummary($m) {
    $sum = [
        'report_email' => [
            'sent_ok' => false,
            'sent_at_utc' => null,
            'attempts' => 0,
            'last_ok' => false,
            'last_attempt_utc' => null,
            'last_http' => null,
            'last_to' => null,
            'message_id' => null,
        ],
    ];
    if (!is_array($m)) return $sum;
    if (!isset($m['email_state']) || !is_array($m['email_state'])) return $sum;
    if (isset($m['email_state']['report_email']) && is_array($m['email_state']['report_email'])) {
        foreach ($sum['report_email'] as $k => $_) {
            if (array_key_exists($k, $m['email_state']['report_email'])) {
                $sum['report_email'][$k] = $m['email_state']['report_email'][$k];
            }
        }
    }
    return $sum;
}

function fm_project_sort_ts($value) {
    if (!is_string($value) || trim($value) === '') return 0;
    $ts = strtotime($value);
    return $ts ?: 0;
}

function fm_project_priority_timestamp($item, $keys) {
    $item = is_array($item) ? $item : [];
    foreach ((array)$keys as $key) {
        $raw = trim((string)($item[$key] ?? ''));
        if ($raw === '') continue;
        $ts = strtotime($raw);
        if ($ts !== false) return (int)$ts;
    }
    return 0;
}

function fm_project_priority_group($item) {
    $item = is_array($item) ? $item : [];
    if (!empty($item['qa_priority'])) return 0;
    if (!empty($item['is_filler'])) return 5;
    $hasPriorityFlag = !empty($item['is_vip']) || !empty($item['is_expedited']);
    $createdTs = fm_project_priority_timestamp($item, ['created_at', 'queued_at', 'uploaded_at', 'date', 'updated_at']);
    $olderThanTwoHours = ($createdTs > 0) ? ((time() - $createdTs) >= 7200) : false;
    if ($hasPriorityFlag && $olderThanTwoHours) return 1;
    if (!$hasPriorityFlag && $olderThanTwoHours) return 2;
    if ($hasPriorityFlag) return 3;
    return 4;
}

function fm_compare_project_priority($a, $b) {
    $a = is_array($a) ? $a : [];
    $b = is_array($b) ? $b : [];
    $groupA = fm_project_priority_group($a);
    $groupB = fm_project_priority_group($b);
    if ($groupA !== $groupB) return $groupA <=> $groupB;

    $createdA = fm_project_priority_timestamp($a, ['created_at', 'queued_at', 'uploaded_at', 'date', 'updated_at', 'assigned_at', 'reserved_at', 'started_at']);
    $createdB = fm_project_priority_timestamp($b, ['created_at', 'queued_at', 'uploaded_at', 'date', 'updated_at', 'assigned_at', 'reserved_at', 'started_at']);
    $sortA = $createdA > 0 ? $createdA : PHP_INT_MAX;
    $sortB = $createdB > 0 ? $createdB : PHP_INT_MAX;
    if ($sortA !== $sortB) return $sortA <=> $sortB;

    $enteredA = fm_project_priority_timestamp($a, ['updated_at', 'uploaded_at', 'date', 'assigned_at', 'reserved_at', 'started_at']);
    $enteredB = fm_project_priority_timestamp($b, ['updated_at', 'uploaded_at', 'date', 'assigned_at', 'reserved_at', 'started_at']);
    $enteredSortA = $enteredA > 0 ? $enteredA : PHP_INT_MAX;
    $enteredSortB = $enteredB > 0 ? $enteredB : PHP_INT_MAX;
    if ($enteredSortA !== $enteredSortB) return $enteredSortA <=> $enteredSortB;

    return strcmp((string)($a['id'] ?? ''), (string)($b['id'] ?? ''));
}

function fm_project_reserve_for_actor($projectId, $email, $name = '') {
    return fm_api_json('POST', 'projects/' . rawurlencode((string)$projectId) . '/queue/reserve', [
        'reserved_for' => [
            'email' => (string)$email,
            'name' => (string)$name,
        ],
        'actor' => fm_current_actor(),
    ]);
}

function fm_project_has_pending_force_kick_for_email($manifest, $email) {
    $me = strtolower(trim((string)$email));
    if ($me === '' || !is_array($manifest)) return false;

    $kick = $manifest['force_kick'] ?? null;
    if (!is_array($kick)) return false;
    if (!empty($kick['acknowledged'])) return false;

    $kickEmail = strtolower(trim((string)($kick['email'] ?? '')));
    return $kickEmail !== '' && $kickEmail === $me;
}

function fm_collect_claimable_queue_projects($email) {
    $me = strtolower(trim((string)$email));
    if ($me === '') return [];
    $projects = [];

    foreach (fm_fetch_all_projects(true) as $manifest) {
        $m = fm_legacy_manifest($manifest);
        if (!is_array($m)) continue;

        $status = strtolower(trim((string)($m['status'] ?? '')));
        if (!in_array($status, ['queued', 'ready', 'correction_needed', 'requeue'], true)) continue;
        if (!empty($m['is_tutorial_instance'])) continue;
        if (fm_project_has_pending_force_kick_for_email($m, $me)) continue;

        $reserved = strtolower(trim((string)($m['reserved_to_email'] ?? '')));
        if ($reserved !== '' && $reserved !== $me) continue;

        if (in_array($status, ['queued', 'ready'], true) && !empty($m['started_at'])) continue;

        if (in_array($status, ['correction_needed', 'requeue'], true)) {
            $corrTo = strtolower(trim((string)($m['correction_to_email'] ?? ($m['assigned_to_email'] ?? ''))));
            if ($corrTo !== '' && $corrTo !== $me && function_exists('isUserOnline') && isUserOnline($corrTo)) {
                continue;
            }
        }

        $projectId = (string)($m['id'] ?? $m['folder'] ?? $m['project_id'] ?? '');
        if ($projectId === '') continue;

        $projects[] = [
            'id' => $projectId,
            'address' => $m['address'] ?? '',
            'status' => $status,
            'created_at' => $m['created_at'] ?: null,
            'queued_at' => $m['queued_at'] ?: null,
            'updated_at' => $m['updated_at'] ?: null,
            'uploaded_at' => $m['uploaded_at'] ?: null,
            'assigned_at' => $m['assigned_at'] ?: null,
            'reserved_at' => $m['reserved_at'] ?: null,
            'assigned_to_email' => $m['assigned_to_email'] ?: null,
            'reserved_to_email' => $m['reserved_to_email'] ?: null,
            'correction_to_email' => $m['correction_to_email'] ?: null,
            'is_filler' => !empty($m['is_filler']),
            'is_vip' => !empty($m['is_vip']),
            'is_expedited' => !empty($m['is_expedited']),
            'qa_priority' => !empty($m['qa_priority']),
        ];
    }

    usort($projects, 'fm_compare_project_priority');
    return $projects;
}

function fm_collect_user_active_projects_fast($email, $queueMode = null) {
    $me = strtolower(trim((string)$email));
    if ($me === '') return null;

    $payload = [
        'actor' => fm_current_actor(),
        'include_active_projects' => true,
    ];
    $queueMode = trim((string)$queueMode);
    if ($queueMode !== '') $payload['queue_mode'] = $queueMode;

    $res = fm_api_json('POST', 'queue/status/compat', $payload);
    if (empty($res['ok']) || !is_array($res['json'] ?? null) || !array_key_exists('active_projects', $res['json'])) {
        return null;
    }

    $activeStatuses = ['queued', 'ready', 'processing', 'in_progress', 'correction_needed', 'requeue'];
    $projects = [];
    foreach (fm_as_array($res['json']['active_projects'] ?? []) as $manifest) {
        $m = fm_legacy_manifest($manifest);
        if (!is_array($m)) continue;

        $status = strtolower(trim((string)($m['status'] ?? '')));
        if (!in_array($status, $activeStatuses, true)) continue;
        if (fm_project_has_pending_force_kick_for_email($m, $me)) continue;

        $assigned = strtolower(trim((string)($m['assigned_to_email'] ?? '')));
        $correction = strtolower(trim((string)($m['correction_to_email'] ?? '')));
        $reserved = strtolower(trim((string)($m['reserved_to_email'] ?? '')));
        $hasOwnershipFields = ($assigned !== '' || $correction !== '' || $reserved !== '');
        if ($hasOwnershipFields && $assigned !== $me && $correction !== $me && $reserved !== $me) continue;

        $projectId = (string)($m['id'] ?? $m['folder'] ?? $m['project_id'] ?? '');
        if ($projectId === '') continue;

        $projects[] = [
            'id' => $projectId,
            'address' => $m['address'] ?? '',
            'status' => $status,
            'created_at' => $m['created_at'] ?: null,
            'updated_at' => $m['updated_at'] ?: null,
            'started_at' => $m['started_at'] ?: null,
            'uploaded_at' => $m['uploaded_at'] ?: null,
            'assigned_at' => $m['assigned_at'] ?: null,
            'queued_at' => $m['queued_at'] ?: null,
            'reserved_at' => $m['reserved_at'] ?: null,
            'assigned_to_email' => $m['assigned_to_email'] ?: null,
            'assigned_to_name' => $m['assigned_to_name'] ?: null,
            'reserved_to_email' => $m['reserved_to_email'] ?: null,
            'reserved_to_name' => $m['reserved_to_name'] ?: null,
            'correction_to_email' => $m['correction_to_email'] ?: null,
            'correction_to_name' => $m['correction_to_name'] ?: null,
            'is_filler' => !empty($m['is_filler']),
            'is_vip' => !empty($m['is_vip']),
            'is_expedited' => !empty($m['is_expedited']),
            'qa_priority' => !empty($m['qa_priority']),
            'project_type' => $m['project_type'] ?? 'residential',
            'complexity' => $m['complexity'] ?? 'complex',
            'work_history' => fm_as_array($m['work_history'] ?? []),
        ];
    }

    usort($projects, 'fm_compare_project_priority');
    return $projects;
}

function fm_collect_user_active_projects($email) {
    $me = strtolower(trim((string)$email));
    if ($me === '') return [];

    $assignedStatuses = ['queued', 'ready', 'processing', 'in_progress', 'correction_needed', 'requeue'];
    $reservedStatuses = ['queued', 'ready', 'processing', 'in_progress', 'correction_needed', 'requeue'];
    $correctionStatuses = ['correction_needed', 'requeue'];
    $linkedStatuses = ['queued', 'ready', 'processing', 'in_progress', 'correction_needed', 'requeue'];
    $projects = [];
    $linkedProjectIds = [];

    if (function_exists('readUserDataByEmail')) {
        $userData = readUserDataByEmail($me);
        if (is_array($userData)) {
            foreach (fm_as_array($userData['projects'] ?? []) as $projectId) {
                $projectId = strtolower(trim((string)$projectId));
                if ($projectId !== '') $linkedProjectIds[$projectId] = true;
            }
        }
    }

    foreach (fm_fetch_all_projects(true) as $manifest) {
        $m = fm_legacy_manifest($manifest);
        if (!is_array($m)) continue;

        $status = strtolower(trim((string)($m['status'] ?? '')));
        if ($status === '') continue;
        if (fm_project_has_pending_force_kick_for_email($m, $me)) continue;

        $assigned = strtolower(trim((string)($m['assigned_to_email'] ?? '')));
        $correction = strtolower(trim((string)($m['correction_to_email'] ?? '')));
        $reserved = strtolower(trim((string)($m['reserved_to_email'] ?? '')));
        $projectId = (string)($m['id'] ?? $m['folder'] ?? $m['project_id'] ?? '');
        $projectKey = strtolower(trim($projectId));

        $isAssigned = ($assigned === $me) && in_array($status, $assignedStatuses, true);
        $isReserved = ($reserved === $me) && in_array($status, $reservedStatuses, true);
        $isCorrection = ($correction === $me || $assigned === $me || $reserved === $me) && in_array($status, $correctionStatuses, true);
        $isLinked = isset($linkedProjectIds[$projectKey]) && in_array($status, $linkedStatuses, true);
        if (!$isAssigned && !$isReserved && !$isCorrection && !$isLinked) continue;

        if ($projectId === '') continue;

        $projects[] = [
            'id' => $projectId,
            'address' => $m['address'] ?? '',
            'status' => $status,
            'created_at' => $m['created_at'] ?: null,
            'updated_at' => $m['updated_at'] ?: null,
            'started_at' => $m['started_at'] ?: null,
            'uploaded_at' => $m['uploaded_at'] ?: null,
            'assigned_at' => $m['assigned_at'] ?: null,
            'queued_at' => $m['queued_at'] ?: null,
            'reserved_at' => $m['reserved_at'] ?: null,
            'assigned_to_email' => $m['assigned_to_email'] ?: null,
            'assigned_to_name' => $m['assigned_to_name'] ?: null,
            'reserved_to_email' => $m['reserved_to_email'] ?: null,
            'reserved_to_name' => $m['reserved_to_name'] ?: null,
            'correction_to_email' => $m['correction_to_email'] ?: null,
            'correction_to_name' => $m['correction_to_name'] ?: null,
            'is_filler' => !empty($m['is_filler']),
            'is_vip' => !empty($m['is_vip']),
            'is_expedited' => !empty($m['is_expedited']),
            'qa_priority' => !empty($m['qa_priority']),
            'project_type' => $m['project_type'] ?? 'residential',
            'complexity' => $m['complexity'] ?? 'complex',
            'work_history' => fm_as_array($m['work_history'] ?? []),
        ];
    }

    usort($projects, 'fm_compare_project_priority');

    return $projects;
}

function fm_pick_resume_project($projects) {
    if (!is_array($projects) || empty($projects)) return null;
    usort($projects, 'fm_compare_project_priority');
    foreach ($projects as $project) {
        if (!is_array($project)) continue;
        $assigned = strtolower(trim((string)($project['assigned_to_email'] ?? '')));
        $correction = strtolower(trim((string)($project['correction_to_email'] ?? '')));
        if ($assigned !== '' || $correction !== '') return $project;
    }
    return null;
}

if (!function_exists('projectIsTestOrg')) {
    function projectIsTestOrg($manifest) {
        if (!is_array($manifest)) return false;

        $orgId = function_exists('orgNormalizeId')
            ? orgNormalizeId($manifest['organization_id'] ?? '')
            : strtolower(trim((string)($manifest['organization_id'] ?? '')));

        if ($orgId === '') {
            $ownerEmail = strtolower(trim((string)($manifest['owner_email'] ?? '')));
            if ($ownerEmail !== '' && $ownerEmail !== 'system' && function_exists('readUserDataByEmail')) {
                $user = readUserDataByEmail($ownerEmail);
                if (is_array($user)) {
                    $orgId = function_exists('orgNormalizeId')
                        ? orgNormalizeId($user['organization_id'] ?? '')
                        : strtolower(trim((string)($user['organization_id'] ?? '')));
                }
            }
        }

        if ($orgId === '') {
            $issuer = fm_as_array($manifest['issuer'] ?? []);
            $issuerEmail = strtolower(trim((string)($issuer['email'] ?? '')));
            if ($issuerEmail !== '' && strpos($issuerEmail, 'system') === false && function_exists('readUserDataByEmail')) {
                $user = readUserDataByEmail($issuerEmail);
                if (is_array($user)) {
                    $orgId = function_exists('orgNormalizeId')
                        ? orgNormalizeId($user['organization_id'] ?? '')
                        : strtolower(trim((string)($user['organization_id'] ?? '')));
                }
            }
        }

        if ($orgId === '' || !function_exists('orgRead')) return false;
        $org = orgRead($orgId);
        return is_array($org) && !empty($org['is_test']);
    }
}

function fm_stats_history_timestamp($history, $eventNames) {
    $events = [];
    foreach ((array)$eventNames as $eventName) {
        $eventName = strtolower(trim((string)$eventName));
        if ($eventName !== '') $events[$eventName] = true;
    }
    if (empty($events)) return null;

    $history = array_values(array_filter(fm_as_array($history), 'is_array'));
    for ($i = count($history) - 1; $i >= 0; $i--) {
        $event = $history[$i];
        $eventName = strtolower(trim((string)($event['event'] ?? '')));
        if ($eventName === '' || !isset($events[$eventName])) continue;

        foreach (['ts', 'at', 'date', 'created_at', 'updated_at'] as $key) {
            if (!empty($event[$key])) return (string)$event[$key];
        }
    }

    return null;
}

function fm_stats_count_history_events($history, $eventNames) {
    $events = [];
    foreach ((array)$eventNames as $eventName) {
        $eventName = strtolower(trim((string)$eventName));
        if ($eventName !== '') $events[$eventName] = true;
    }
    if (empty($events)) return 0;

    $count = 0;
    foreach (fm_as_array($history) as $event) {
        if (!is_array($event)) continue;
        $eventName = strtolower(trim((string)($event['event'] ?? '')));
        if ($eventName !== '' && isset($events[$eventName])) $count++;
    }
    return $count;
}

function fm_stats_project_record($manifest, $options = []) {
    $m = fm_legacy_manifest($manifest);
    $status = trim((string)($m['status'] ?? ''));
    if ($status === '') $status = 'completed';

    $pins = fm_as_array($m['pins'] ?? []);
    $projectId = (string)($m['id'] ?? $m['folder'] ?? $m['project_id'] ?? '');
    $history = fm_manifest_work_history($m);
    $qaHistory = fm_as_array($m['qa_history'] ?? []);
    $qaRejectCount = isset($m['qa_reject_count'])
        ? (int)$m['qa_reject_count']
        : (count($qaHistory) + fm_stats_count_history_events($history, ['qa_rejected', 'qa_sent_back_to_tech', 'manager_sent_back_to_tech']));
    $rejectedAt = $m['rejected_at'] ?: fm_stats_history_timestamp($history, ['rejected_no_coverage', 'rejected', 'manager_rejected', 'rejection_reviewed']);
    $qaApprovedAt = ($m['qa_approved_at'] ?? null)
        ?: (($m['qa_completed_at'] ?? null)
            ?: fm_stats_history_timestamp($history, ['qa_approved', 'qa_approved_pending_manager', 'qa_reviewed']));

    $record = [
        'id' => $projectId,
        'address' => $m['address'] ?? null,
        'status' => $status,
        'created_at' => $m['created_at'] ?: null,
        'completed_at' => $m['completed_at'] ?: null,
        'rejected_at' => $rejectedAt ?: null,
        'started_at' => $m['started_at'] ?: null,
        'uploaded_at' => $m['uploaded_at'] ?: null,
        'assigned_at' => $m['assigned_at'] ?: null,
        'queued_at' => $m['queued_at'] ?: null,
        'updated_at' => $m['updated_at'] ?: null,
        'qa_claimed_at' => $m['qa_claimed_at'] ?: null,
        'qa_started_at' => ($m['qa_started_at'] ?? null) ?: null,
        'qa_approved_at' => $qaApprovedAt ?: null,
        'qa_completed_at' => ($m['qa_completed_at'] ?? null) ?: ($qaApprovedAt ?: null),
        'assigned_to_email' => $m['assigned_to_email'] ?: null,
        'is_filler' => !empty($m['is_filler']),
        'is_test_org' => projectIsTestOrg($m),
        'is_vip' => !empty($m['is_vip']),
        'is_expedited' => !empty($m['is_expedited']),
        'project_type' => $m['project_type'] ?? 'residential',
        'amount_charged' => isset($m['amount_charged']) ? (float)$m['amount_charged'] : null,
        'instant_enabled' => !empty($m['instant_enabled']),
        'instant_only' => !empty($m['instant_only']),
        'report_mode' => $m['report_mode'] ?? null,
        'refund_amount' => isset($m['refund_amount']) ? (float)$m['refund_amount'] : 0,
        'refund_issued' => !empty($m['refund_issued']),
        'refund_pending' => !empty($m['refund_pending']),
        'pin_count' => count($pins) > 0 ? count($pins) : 1,
        'team_id' => $m['team_id'] ?? 'default',
        'organization_id' => $m['organization_id'] ?: null,
        'complexity' => $m['complexity'] ?? 'complex',
        'qa_reject_count' => $qaRejectCount,
        'manager_audit_status' => $m['manager_audit_status'] ?? null,
        'manager_audit_note' => $m['manager_audit_note'] ?? null,
    ];

    if (!empty($options['include_history'])) {
        $record['qa_history'] = $qaHistory;
        $record['work_history'] = $history;
    }

    return $record;
}

function fm_manager_review_require_index() {
    // The legacy PHP SQLite project index has been retired from the live app.
    // Manager-review fallbacks now use Node-backed project queries instead.
    return false;
}

function fm_manager_review_project_dir($projectId, $pathType = '') {
    $projectId = trim((string)$projectId);
    if ($projectId === '') return null;

    $baseDir = __DIR__ . '/saves/';
    $tutorialDir = storageDir('tutorials');
    $pathType = strtolower(trim((string)$pathType));

    $candidates = [];
    if ($pathType === 'saves') {
        $candidates[] = $baseDir . $projectId . '/';
    } elseif ($pathType === 'tm') {
        $candidates[] = $tutorialDir . 'master/' . $projectId . '/';
    } else {
        $candidates[] = $baseDir . $projectId . '/';
        $candidates[] = $tutorialDir . 'master/' . $projectId . '/';
    }

    foreach ($candidates as $dir) {
        if (is_dir($dir)) return $dir;
    }

    if (!is_dir($tutorialDir)) return null;

    $entries = @scandir($tutorialDir);
    if (!is_array($entries)) return null;

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..' || $entry === 'master') continue;
        $dir = $tutorialDir . $entry . '/' . $projectId . '/';
        if (is_dir($dir)) return $dir;
    }

    return null;
}

function fm_manager_review_load_manifest($projectId, $pathType = '') {
    $dir = fm_manager_review_project_dir($projectId, $pathType);
    if (!$dir) return [];

    $manifestPath = $dir . 'manifest.json';
    if (!file_exists($manifestPath)) return [];

    $raw = @file_get_contents($manifestPath);
    $data = json_decode((string)$raw, true);
    return is_array($data) ? $data : [];
}

function fm_manager_review_qa_actor($manifest) {
    $history = fm_manifest_work_history($manifest);
    for ($i = count($history) - 1; $i >= 0; $i--) {
        $event = fm_as_array($history[$i] ?? null);
        if (!$event) continue;

        $eventName = strtolower(trim((string)($event['event'] ?? '')));
        if ($eventName === 'qa_approved' || $eventName === 'qa_approved_pending_manager') {
            $email = fm_norm_email($event['qa_email'] ?? '');
            $name = fm_norm_string($event['qa_name'] ?? '');
            if ($email !== '') return ['email' => $email, 'name' => $name !== '' ? $name : $email];
        }

        if ($eventName === 'rejected_no_coverage' || $eventName === 'rejection_reviewed') {
            $email = fm_norm_email($event['by_email'] ?? ($event['reviewer_email'] ?? ''));
            $name = fm_norm_string($event['by_name'] ?? ($event['reviewer_name'] ?? ''));
            if ($email !== '') return ['email' => $email, 'name' => $name !== '' ? $name : $email];
        }
    }

    return ['email' => '', 'name' => ''];
}

function fm_manager_review_project_record($row, $manifest = []) {
    $row = fm_as_array($row);
    $manifest = fm_legacy_manifest($manifest);
    $projectId = trim((string)($row['id'] ?? ($manifest['id'] ?? '')));
    $status = trim((string)($row['st'] ?? ($manifest['status'] ?? 'completed')));
    $qaActor = fm_manager_review_qa_actor($manifest);

    $createdAt = !empty($row['ca']) ? date('Y-m-d H:i:s', (int)$row['ca']) : null;
    $completedAt = !empty($row['da']) ? date('Y-m-d H:i:s', (int)$row['da']) : null;

    return [
        'id' => $projectId,
        'address' => $manifest['address'] ?? null,
        'status' => $status !== '' ? $status : 'completed',
        'created_at' => $createdAt ?: ($manifest['created_at'] ?? null),
        'completed_at' => $completedAt ?: ($manifest['completed_at'] ?? null),
        'assigned_to_email' => ($row['asn'] ?? '') !== '' ? (string)$row['asn'] : ($manifest['assigned_to_email'] ?? null),
        'is_filler' => !empty($row['fl']) || !empty($manifest['is_filler']),
        'is_test_org' => projectIsTestOrg($manifest),
        'is_vip' => !empty($manifest['is_vip']),
        'is_expedited' => !empty($manifest['is_expedited']),
        'project_type' => $manifest['project_type'] ?? 'residential',
        'complexity' => ($row['cx'] ?? '') !== '' ? (string)$row['cx'] : ($manifest['complexity'] ?? 'complex'),
        'manager_audit_status' => $manifest['manager_audit_status'] ?? null,
        'manager_audit_note' => $manifest['manager_audit_note'] ?? null,
        'qa_reviewer_email' => $qaActor['email'],
        'qa_reviewer_name' => $qaActor['name'],
    ];
}

function fm_fetch_manager_review_projects() {
    return null;
}

function fm_fetch_manager_review_projects_fallback() {
    $manifests = fm_project_query([
        'statuses' => ['completed', 'rejected', 'rejected_no_coverage'],
        'include_all' => true,
    ]);

    $projects = [];
    foreach ($manifests as $manifest) {
        if (!is_array($manifest)) continue;

        $legacy = fm_legacy_manifest($manifest);
        $projectId = trim((string)($legacy['id'] ?? $legacy['folder'] ?? ''));
        if ($projectId === '') continue;

        $projects[] = fm_manager_review_project_record([
            'id' => $projectId,
            'st' => $legacy['status'] ?? 'completed',
            'ca' => fm_ts_value($legacy['created_at'] ?? null),
            'da' => fm_ts_value($legacy['completed_at'] ?? null),
            'asn' => $legacy['assigned_to_email'] ?? null,
            'fl' => !empty($legacy['is_filler']) ? 1 : 0,
            'cx' => $legacy['complexity'] ?? 'complex',
        ], $legacy);
    }

    usort($projects, function ($a, $b) {
        $aTs = fm_project_sort_ts((string)($a['completed_at'] ?? $a['created_at'] ?? ''));
        $bTs = fm_project_sort_ts((string)($b['completed_at'] ?? $b['created_at'] ?? ''));
        return $bTs <=> $aTs;
    });

    return $projects;
}

function fm_can_manager_review_user() {
    if (!isset($_SESSION['user_email'])) return false;
    if (function_exists('isAdmin') && isAdmin()) return true;

    $email = fm_norm_email($_SESSION['user_email'] ?? '');
    if ($email === '') return false;

    $role = '';
    if (function_exists('userRoleByEmail')) {
        $role = strtolower(trim((string)userRoleByEmail($email)));
    } elseif (function_exists('readUserDataByEmail')) {
        $u = readUserDataByEmail($email);
        if (is_array($u)) $role = strtolower(trim((string)($u['role'] ?? '')));
    }

    if (in_array($role, ['admin', 'manager'], true)) return true;

    if (function_exists('userHasGlobalPerm')) {
        return userHasGlobalPerm($email, 'manage_qa')
            || userHasGlobalPerm($email, 'manage_qa_queue')
            || userHasGlobalPerm($email, 'manage_queue')
            || userHasGlobalPerm($email, 'is_admin_legacy');
    }

    return false;
}

function fm_manager_audit_mark_project($projectId, $auditStatus, $note = '') {
    $projectId = trim((string)$projectId);
    if ($projectId === '') {
        return ['success' => false, 'error' => 'Project folder is required'];
    }

    $auditStatus = strtolower(trim((string)$auditStatus));
    if (!in_array($auditStatus, ['reviewed', 'flagged'], true)) {
        return ['success' => false, 'error' => 'Audit status must be reviewed or flagged'];
    }

    $manifest = fm_fetch_project_manifest($projectId);
    if (!is_array($manifest)) {
        return ['success' => false, 'error' => 'Project not found'];
    }

    $now = gmdate('Y-m-d H:i:s');
    $actor = fm_current_actor();
    $actorEmail = fm_actor_email($actor);
    $actorName = fm_actor_name($actor);
    $note = trim((string)$note);
    $storedNote = ($auditStatus === 'flagged' && $note !== '') ? $note : null;

    $history = array_values(fm_manifest_work_history($manifest));
    $history[] = [
        'event' => $auditStatus === 'flagged' ? 'manager_audit_flagged' : 'manager_audit_reviewed',
        'ts' => $now,
        'by_email' => $actorEmail !== '' ? $actorEmail : null,
        'by_name' => $actorName !== '' ? $actorName : null,
        'project_id' => $projectId,
        'manager_audit_status' => $auditStatus,
        'manager_audit_note' => $storedNote,
        'previous_manager_audit_status' => $manifest['manager_audit_status'] ?? null,
    ];

    $audit = fm_as_array($manifest['audit'] ?? []);
    $audit['manager_audit_status'] = $auditStatus;
    $audit['manager_audit_note'] = $storedNote;
    $audit['manager_audit_updated_at'] = $now;
    $audit['manager_audit_updated_by_email'] = $actorEmail !== '' ? $actorEmail : null;
    $audit['manager_audit_updated_by_name'] = $actorName !== '' ? $actorName : null;

    if ($auditStatus === 'reviewed') {
        $audit['manager_audit_reviewed_at'] = $now;
        $audit['manager_audit_reviewed_by_email'] = $actorEmail !== '' ? $actorEmail : null;
        $audit['manager_audit_reviewed_by_name'] = $actorName !== '' ? $actorName : null;
    } else {
        $audit['manager_audit_flagged_at'] = $now;
        $audit['manager_audit_flagged_by_email'] = $actorEmail !== '' ? $actorEmail : null;
        $audit['manager_audit_flagged_by_name'] = $actorName !== '' ? $actorName : null;
    }

    $patch = [
        'manager_audit_status' => $auditStatus,
        'manager_audit_note' => $storedNote,
        'manager_audit_updated_at' => $now,
        'manager_audit_updated_by_email' => $actorEmail !== '' ? $actorEmail : null,
        'manager_audit_updated_by_name' => $actorName !== '' ? $actorName : null,
        'audit' => $audit,
        'timestamps' => [
            'updated_at' => $now,
        ],
        'work_history' => $history,
        'workflow' => [
            'history' => $history,
        ],
    ];

    if ($auditStatus === 'reviewed') {
        $patch['manager_audit_reviewed_at'] = $now;
        $patch['manager_audit_reviewed_by_email'] = $actorEmail !== '' ? $actorEmail : null;
        $patch['manager_audit_reviewed_by_name'] = $actorName !== '' ? $actorName : null;
    } else {
        $patch['manager_audit_flagged_at'] = $now;
        $patch['manager_audit_flagged_by_email'] = $actorEmail !== '' ? $actorEmail : null;
        $patch['manager_audit_flagged_by_name'] = $actorName !== '' ? $actorName : null;
    }

    $updated = fm_project_patch($projectId, $patch);
    if (!is_array($updated)) {
        return ['success' => false, 'error' => 'Failed to save manager audit'];
    }

    return [
        'success' => true,
        'folder' => $projectId,
        'manager_audit_status' => $auditStatus,
        'manager_audit_note' => $storedNote,
        'project' => $updated,
    ];
}

function fm_project_complexity_point_value($complexity) {
    $key = strtolower(trim((string)$complexity));
    if ($key === '') return null;
    if (is_numeric($key)) $key = (string)(int)$key;
    else {
        $key = preg_replace('/[^a-z0-9]+/', '_', $key);
        $key = trim((string)$key, '_');
    }

    $map = [
        '1' => 2, '2' => 3, '3' => 4, '4' => 6, '5' => 10,
        'very_simple' => 2, 'very_simple_project' => 2,
        'simple' => 3, 'simple_project' => 3,
        'standard' => 4, 'standard_project' => 4,
        'complex' => 6, 'complex_project' => 6,
        'very_complex' => 10, 'very_complex_project' => 10,
    ];

    return array_key_exists($key, $map) ? (float)$map[$key] : null;
}

function fm_project_manifest_point_value($manifest) {
    $m = fm_as_array($manifest);
    foreach (['point_value', 'project_points', 'points_value', 'points'] as $key) {
        $raw = $m[$key] ?? null;
        if (is_numeric($raw) && (float)$raw > 0) return (float)$raw;
    }
    return fm_project_complexity_point_value($m['complexity'] ?? null);
}

function fm_leaderboard_cached($key, $ttlSeconds, $producer) {
    $safeKey = preg_replace('/[^a-zA-Z0-9_.-]+/', '_', (string)$key);
    if ($safeKey === '') $safeKey = 'default';
    $ttlSeconds = max(1, (int)$ttlSeconds);
    $cachePath = storagePath('meta/leaderboards/' . $safeKey . '.json', true);
    $lockPath = storagePath('locks/leaderboards/' . $safeKey . '.lock', true);
    $now = time();

    $readFresh = function() use ($cachePath, $ttlSeconds, $now) {
        if (!is_file($cachePath)) return null;
        $cached = json_decode(@file_get_contents($cachePath) ?: '{}', true);
        if (!is_array($cached)) return null;
        $ts = (int)($cached['cached_at_ts'] ?? 0);
        if ($ts > 0 && ($now - $ts) < $ttlSeconds && array_key_exists('data', $cached)) {
            $data = is_array($cached['data']) ? $cached['data'] : [];
            $data['cached'] = true;
            $data['cached_at'] = $cached['cached_at'] ?? null;
            return $data;
        }
        return null;
    };

    $fresh = $readFresh();
    if (is_array($fresh)) return $fresh;

    $lock = @fopen($lockPath, 'c');
    if ($lock) @flock($lock, LOCK_EX);
    $fresh = $readFresh();
    if (is_array($fresh)) {
        if ($lock) { @flock($lock, LOCK_UN); @fclose($lock); }
        return $fresh;
    }

    $data = is_callable($producer) ? $producer() : [];
    if (!is_array($data)) $data = [];
    $data['cached'] = false;
    $data['cached_at'] = gmdate('c', $now);
    if (array_key_exists('success', $data) && $data['success'] === false) {
        if ($lock) { @flock($lock, LOCK_UN); @fclose($lock); }
        return $data;
    }
    $payload = [
        'cached_at_ts' => $now,
        'cached_at' => gmdate('c', $now),
        'data' => $data,
    ];
    @file_put_contents($cachePath, json_encode($payload, JSON_PRETTY_PRINT));
    if ($lock) { @flock($lock, LOCK_UN); @fclose($lock); }
    return $data;
}

function fm_leaderboard_pacific_timezone() {
    static $tz = null;
    if ($tz instanceof DateTimeZone) return $tz;
    $tz = new DateTimeZone('America/Los_Angeles');
    return $tz;
}

function fm_leaderboard_pacific_today() {
    return (new DateTimeImmutable('now', fm_leaderboard_pacific_timezone()))->format('Y-m-d');
}

function fm_leaderboard_normalize_date($date = '') {
    $date = trim((string)$date);
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) return $date;
    return fm_leaderboard_pacific_today();
}

function fm_leaderboard_pacific_day_bounds($date = '') {
    $date = fm_leaderboard_normalize_date($date);
    $tz = fm_leaderboard_pacific_timezone();
    $start = new DateTimeImmutable($date . ' 00:00:00', $tz);
    $end = $start->modify('+1 day')->modify('-1 second');
    return [
        'date' => $date,
        'start_ts' => $start->getTimestamp(),
        'end_ts' => $end->getTimestamp(),
        'start_iso' => gmdate('c', $start->getTimestamp()),
        'end_iso' => gmdate('c', $end->getTimestamp()),
        'timezone' => 'America/Los_Angeles',
        'is_today' => $date === fm_leaderboard_pacific_today(),
    ];
}

function fm_leaderboard_cache_ttl_for_date($date = '') {
    $date = fm_leaderboard_normalize_date($date);
    return $date < fm_leaderboard_pacific_today() ? 315360000 : 30;
}

function fm_leaderboard_rank_points_rows($rows) {
    $list = array_values(array_filter((array)$rows, 'is_array'));
    usort($list, function($a, $b) {
        if ((float)($a['points'] ?? 0) !== (float)($b['points'] ?? 0)) return (float)($b['points'] ?? 0) <=> (float)($a['points'] ?? 0);
        if ((int)($a['completed_count'] ?? 0) !== (int)($b['completed_count'] ?? 0)) return (int)($b['completed_count'] ?? 0) <=> (int)($a['completed_count'] ?? 0);
        return strcmp((string)($a['name'] ?? ''), (string)($b['name'] ?? ''));
    });
    $rank = 0;
    $lastPoints = null;
    $lastCount = null;
    foreach ($list as $idx => &$row) {
        $points = round((float)($row['points'] ?? 0), 2);
        $count = (int)($row['completed_count'] ?? 0);
        if ($lastPoints === null || $points !== $lastPoints || $count !== $lastCount) $rank = $idx + 1;
        $row['rank'] = $rank;
        $row['points'] = $points;
        $row['completed_count'] = $count;
        $lastPoints = $points;
        $lastCount = $count;
    }
    unset($row);
    return $list;
}

function fm_project_actor_email_from_manifest($manifest) {
    $m = fm_as_array($manifest);
    $payTech = fm_project_pay_technician_from_manifest($m, $m['technician_history'] ?? null);
    $payEmail = fm_norm_email($payTech['email'] ?? '');
    if ($payEmail !== '') return $payEmail;
    $qaEmails = [];
    foreach ([
        $m['qa_claimed_by_email'] ?? null,
        $m['qa_approved_by_email'] ?? null,
        $m['qa_approved_by'] ?? null,
        $m['qa_reviewed_by_email'] ?? null,
        $m['qa_reviewed_by'] ?? null,
        $m['workflow']['qa_claim']['email'] ?? null,
    ] as $rawEmail) {
        $email = fm_norm_email($rawEmail);
        if ($email !== '') $qaEmails[$email] = true;
    }
    $techEvents = ['claimed_new' => true, 'claimed_correction' => true, 'submitted_for_qa' => true, 'correction_submitted' => true, 'reopened_project_claimed' => true];
    $workHistory = fm_as_array($m['work_history'] ?? ($m['workflow']['history'] ?? []));
    for ($i = count($workHistory) - 1; $i >= 0; $i--) {
        $event = fm_as_array($workHistory[$i] ?? []);
        $eventName = strtolower(trim((string)($event['event'] ?? ($event['type'] ?? ''))));
        if ($eventName === '' || !isset($techEvents[$eventName])) continue;
        $email = fm_norm_email($event['worker_email'] ?? ($event['assigned_to_email'] ?? ''));
        if ($email !== '') return $email;
    }
    foreach ([
        'display_technician_email',
        'latest_technician_email',
        'assigned_to_email',
        'technician_email',
        'drafter_email',
        'worker_email',
    ] as $key) {
        $email = fm_norm_email($m[$key] ?? '');
        if ($email !== '' && isset($qaEmails[$email])) continue;
        if ($email !== '') return $email;
    }
    $history = fm_as_array($m['technician_history'] ?? []);
    for ($i = count($history) - 1; $i >= 0; $i--) {
        $email = fm_norm_email($history[$i]['email'] ?? '');
        if ($email !== '' && isset($qaEmails[$email])) continue;
        if ($email !== '') return $email;
    }
    return '';
}

function fm_project_actor_name_from_manifest($manifest, $email = '') {
    $m = fm_as_array($manifest);
    $targetEmail = fm_norm_email($email);
    $payTech = fm_project_pay_technician_from_manifest($m, $m['technician_history'] ?? null);
    if (is_array($payTech)) {
        $payEmail = fm_norm_email($payTech['email'] ?? '');
        $payName = fm_norm_string($payTech['name'] ?? '');
        if (($targetEmail === '' || $payEmail === '' || $payEmail === $targetEmail) && $payName !== '') return $payName;
    }
    $techEvents = ['claimed_new' => true, 'claimed_correction' => true, 'submitted_for_qa' => true, 'correction_submitted' => true, 'reopened_project_claimed' => true];
    $workHistory = fm_as_array($m['work_history'] ?? ($m['workflow']['history'] ?? []));
    for ($i = count($workHistory) - 1; $i >= 0; $i--) {
        $event = fm_as_array($workHistory[$i] ?? []);
        $eventName = strtolower(trim((string)($event['event'] ?? ($event['type'] ?? ''))));
        if ($eventName === '' || !isset($techEvents[$eventName])) continue;
        $eventEmail = fm_norm_email($event['worker_email'] ?? ($event['assigned_to_email'] ?? ''));
        if ($targetEmail !== '' && $eventEmail !== $targetEmail) continue;
        $name = trim((string)($event['worker_name'] ?? ($event['assigned_to_name'] ?? '')));
        if ($name !== '') return $name;
    }
    foreach ([
        ['email' => 'display_technician_email', 'name' => 'display_technician_name'],
        ['email' => 'latest_technician_email', 'name' => 'latest_technician_name'],
        ['email' => 'assigned_to_email', 'name' => 'assigned_to_name'],
        ['email' => 'technician_email', 'name' => 'technician_name'],
        ['email' => 'drafter_email', 'name' => 'drafter_name'],
        ['email' => 'worker_email', 'name' => 'worker_name'],
    ] as $pair) {
        if ($targetEmail !== '') {
            $candidateEmail = fm_norm_email($m[$pair['email']] ?? '');
            if ($candidateEmail !== '' && $candidateEmail !== $targetEmail) continue;
        }
        $name = trim((string)($m[$pair['name']] ?? ''));
        if ($name !== '') return $name;
    }
    $history = fm_as_array($m['technician_history'] ?? []);
    for ($i = count($history) - 1; $i >= 0; $i--) {
        $entry = fm_as_array($history[$i] ?? []);
        if ($targetEmail !== '' && fm_norm_email($entry['email'] ?? '') !== $targetEmail) continue;
        $name = trim((string)($entry['name'] ?? ''));
        if ($name !== '') return $name;
    }
    return $targetEmail !== '' ? $targetEmail : 'Technician';
}

function fm_project_qa_actor_email_from_manifest($manifest) {
    $m = fm_as_array($manifest);
    foreach ([
        $m['qa_claimed_by_email'] ?? null,
        $m['qa_approved_by_email'] ?? null,
        $m['qa_approved_by'] ?? null,
        $m['qa_reviewed_by_email'] ?? null,
        $m['qa_reviewed_by'] ?? null,
        $m['workflow']['qa_claim']['email'] ?? null,
    ] as $rawEmail) {
        $email = fm_norm_email($rawEmail);
        if ($email !== '') return $email;
    }
    $qaEvents = ['qa_approved' => true, 'qa_approved_pending_manager' => true, 'qa_reviewed' => true, 'qa_claimed' => true];
    $workHistory = fm_as_array($m['work_history'] ?? ($m['workflow']['history'] ?? []));
    for ($i = count($workHistory) - 1; $i >= 0; $i--) {
        $event = fm_as_array($workHistory[$i] ?? []);
        $eventName = strtolower(trim((string)($event['event'] ?? ($event['type'] ?? ''))));
        if ($eventName === '' || !isset($qaEvents[$eventName])) continue;
        $email = fm_norm_email($event['qa_email'] ?? ($event['qa_reviewer_email'] ?? ($event['by_email'] ?? ($event['user_email'] ?? ''))));
        if ($email !== '') return $email;
    }
    return '';
}

function fm_project_qa_activity_ts_from_manifest($manifest) {
    $m = fm_as_array($manifest);
    foreach ([
        $m['qa_approved_at'] ?? null,
        $m['qa_reviewed_at'] ?? null,
        $m['qa_completed_at'] ?? null,
        $m['completed_at'] ?? null,
        $m['date'] ?? null,
    ] as $rawTs) {
        $ts = fm_ts_value($rawTs);
        if ($ts !== null) return $ts;
    }
    $qaEvents = ['qa_approved' => true, 'qa_approved_pending_manager' => true, 'qa_reviewed' => true, 'qa_claimed' => true];
    $workHistory = fm_as_array($m['work_history'] ?? ($m['workflow']['history'] ?? []));
    for ($i = count($workHistory) - 1; $i >= 0; $i--) {
        $event = fm_as_array($workHistory[$i] ?? []);
        $eventName = strtolower(trim((string)($event['event'] ?? ($event['type'] ?? ''))));
        if ($eventName === '' || !isset($qaEvents[$eventName])) continue;
        $ts = fm_ts_value($event['ts'] ?? ($event['at'] ?? ($event['date'] ?? ($event['created_at'] ?? null))));
        if ($ts !== null) return $ts;
    }
    return null;
}

function fm_active_qa_emails_for_leaderboard($teamKey = 'all') {
    $emails = [];
    if (!function_exists('fm_api_json')) return $emails;
    $payload = [
        'include' => 'qa,pending_rejection',
        'view' => 'card',
    ];
    $teamKey = trim((string)$teamKey);
    if ($teamKey !== '' && strtolower($teamKey) !== 'all') $payload['team'] = $teamKey;
    $res = fm_api_json('POST', 'queue/admin/overview/compat', $payload);
    if (!$res['ok'] || !is_array($res['json'])) return $emails;
    $json = $res['json'];
    $items = array_merge(
        fm_as_array($json['qa'] ?? []),
        fm_as_array($json['qa_waiting'] ?? []),
        fm_as_array($json['qa_in_progress'] ?? []),
        fm_as_array($json['pending_rejection'] ?? [])
    );
    foreach ($items as $item) {
        $item = fm_as_array($item);
        $email = fm_norm_email($item['qa_claimed_by_email'] ?? ($item['workflow']['qa_claim']['email'] ?? ''));
        if ($email !== '') $emails[$email] = true;
    }
    return $emails;
}

function fm_technician_leaderboard_for_date($teamKey = 'all', $date = '') {
    $teamKey = trim((string)$teamKey);
    if ($teamKey === '' || strtolower($teamKey) === 'default') $teamKey = 'all';
    $bounds = fm_leaderboard_pacific_day_bounds($date);
    $date = $bounds['date'];
    $ttl = fm_leaderboard_cache_ttl_for_date($date);
    return fm_leaderboard_cached('technician_day_v6_' . strtolower($teamKey) . '_' . $date, $ttl, function() use ($teamKey, $bounds, $date) {
        $startTs = (int)$bounds['start_ts'];
        $endTs = !empty($bounds['is_today']) ? time() : (int)$bounds['end_ts'];
        $payload = [
            'statuses' => ['completed'],
            'activity_start' => $bounds['start_iso'],
            'activity_end' => gmdate('c', $endTs),
            'activity_fields' => ['completed'],
            'include_all' => true,
        ];
        if ($teamKey !== 'all') $payload['team'] = $teamKey;
        $projects = [];
        if (function_exists('fm_api_json')) {
            $res = fm_api_json('POST', 'projects/query', $payload);
            if (!$res['ok'] || !is_array($res['json'])) {
                return [
                    'success' => false,
                    'error' => 'Unable to load completed projects for technician leaderboard',
                    'leaderboard' => [],
                    'team' => $teamKey,
                    'date' => $date,
                    'timezone' => $bounds['timezone'],
                ];
            }
            foreach (fm_as_array($res['json']['projects'] ?? []) as $manifest) {
                $projects[] = fm_legacy_manifest($manifest);
            }
        } elseif (function_exists('fm_fetch_all_projects')) {
            $projects = fm_fetch_all_projects(true);
        }
        $qaTodayEmails = !empty($bounds['is_today']) ? fm_active_qa_emails_for_leaderboard($teamKey) : [];
        foreach (array_values(array_filter((array)$projects, 'is_array')) as $manifest) {
            $m = fm_legacy_manifest($manifest);
            if (!is_array($m)) continue;
            if (!empty($m['is_filler']) || !empty($m['is_tutorial_instance'])) continue;
            $qaEmail = fm_project_qa_actor_email_from_manifest($m);
            if ($qaEmail === '') continue;
            $qaTs = fm_project_qa_activity_ts_from_manifest($m);
            if ($qaTs !== null && $qaTs >= $startTs && $qaTs <= $endTs) $qaTodayEmails[$qaEmail] = true;
        }
        $rows = [];
        foreach (array_values(array_filter((array)$projects, 'is_array')) as $manifest) {
            $m = fm_legacy_manifest($manifest);
            if (!is_array($m)) continue;
            if (!empty($m['is_filler']) || !empty($m['is_tutorial_instance'])) continue;
            if ($teamKey !== 'all') {
                $projectTeam = trim((string)($m['team_id'] ?? ($m['team'] ?? '')));
                if ($projectTeam !== '' && strtolower($projectTeam) !== strtolower($teamKey)) continue;
            }
            $completedTs = strtotime((string)($m['completed_at'] ?? ($m['timestamps']['completed_at'] ?? '')));
            if ($completedTs === false || $completedTs < $startTs || $completedTs > $endTs) continue;
            $email = fm_project_actor_email_from_manifest($m);
            if ($email === '') continue;
            if (isset($qaTodayEmails[$email])) continue;
            $points = fm_project_manifest_point_value($m);
            if ($points === null || $points <= 0) $points = 1.0;
            if (!isset($rows[$email])) {
                $rows[$email] = [
                    'email' => $email,
                    'name' => fm_project_actor_name_from_manifest($m, $email),
                    'completed_count' => 0,
                    'points' => 0,
                ];
            }
            $rows[$email]['completed_count']++;
            $rows[$email]['points'] += (float)$points;
        }
        $list = fm_leaderboard_rank_points_rows($rows);
        return [
            'success' => true,
            'leaderboard' => $list,
            'team' => $teamKey,
            'date' => $date,
            'timezone' => $bounds['timezone'],
            'frozen' => empty($bounds['is_today']),
        ];
    });
}

function fm_technician_leaderboard_today($teamKey = 'all') {
    return fm_technician_leaderboard_for_date($teamKey, fm_leaderboard_pacific_today());
}

function fm_can_view_technician_leaderboard() {
    if (!isset($_SESSION['user_email'])) return false;
    if (function_exists('isAdmin') && isAdmin()) return true;
    $email = fm_norm_email($_SESSION['user_email'] ?? '');
    if ($email === '') return false;
    $role = '';
    if (function_exists('userRoleByEmail')) $role = strtolower(trim((string)userRoleByEmail($email)));
    if (in_array($role, ['admin', 'manager', 'technician'], true)) return true;
    if (function_exists('userHasGlobalPerm')) {
        return userHasGlobalPerm($email, 'manage_queue') || userHasGlobalPerm($email, 'is_admin_legacy');
    }
    return false;
}

function fm_manager_override_project_complexity($projectId, $complexity, $reason, $notes = '') {
    $projectId = trim((string)$projectId);
    if ($projectId === '') {
        return ['success' => false, 'error' => 'Project folder is required'];
    }

    $newComplexity = (int)$complexity;
    if ($newComplexity < 1 || $newComplexity > 5) {
        return ['success' => false, 'error' => 'Complexity must be a level from 1 to 5'];
    }

    $reason = trim((string)$reason);
    $notes = trim((string)$notes);
    if ($reason === '') {
        return ['success' => false, 'error' => 'A reason is required to override complexity'];
    }

    $manifest = fm_fetch_project_manifest($projectId);
    if (!is_array($manifest)) {
        return ['success' => false, 'error' => 'Project not found'];
    }

    $previousComplexityRaw = $manifest['complexity'] ?? null;
    $previousComplexity = is_numeric($previousComplexityRaw) ? (int)$previousComplexityRaw : trim((string)$previousComplexityRaw);
    $previousPointValue = fm_project_manifest_point_value($manifest);
    $newPointValue = fm_project_complexity_point_value($newComplexity);
    if ($newPointValue === null) {
        return ['success' => false, 'error' => 'Unable to resolve points for selected complexity'];
    }

    if ((string)$previousComplexity === (string)$newComplexity && (float)$previousPointValue === (float)$newPointValue) {
        return ['success' => false, 'error' => 'Complexity is already set to that value'];
    }

    $now = gmdate('Y-m-d H:i:s');
    $actor = fm_current_actor();
    $actorEmail = fm_actor_email($actor);
    $actorName = fm_actor_name($actor);
    $audit = fm_as_array($manifest['audit'] ?? []);
    $history = array_values(fm_manifest_work_history($manifest));
    $overrideHistory = array_values(array_filter(fm_as_array($manifest['complexity_history'] ?? ($audit['complexity_history'] ?? [])), 'is_array'));
    $originalComplexity = $manifest['complexity_original'] ?? ($audit['complexity_original'] ?? $previousComplexity);
    $originalPointValue = $manifest['point_value_original'] ?? ($audit['point_value_original'] ?? $previousPointValue);

    $entry = [
        'event' => 'complexity_changed',
        'ts' => $now,
        'project_id' => $projectId,
        'by_email' => $actorEmail !== '' ? $actorEmail : null,
        'by_name' => $actorName !== '' ? $actorName : null,
        'original_complexity' => $originalComplexity,
        'original_point_value' => $originalPointValue,
        'previous_complexity' => $previousComplexity,
        'previous_point_value' => $previousPointValue,
        'new_complexity' => $newComplexity,
        'new_point_value' => $newPointValue,
        'reason' => $reason,
        'note' => $notes !== '' ? $notes : $reason,
    ];

    $overrideHistory[] = $entry;
    if (count($overrideHistory) > 100) $overrideHistory = array_slice($overrideHistory, -100);
    $history[] = $entry;

    $audit['complexity_original'] = $originalComplexity;
    $audit['point_value_original'] = $originalPointValue;
    $audit['complexity_updated_at'] = $now;
    $audit['complexity_updated_by_email'] = $actorEmail !== '' ? $actorEmail : null;
    $audit['complexity_updated_by_name'] = $actorName !== '' ? $actorName : null;
    $audit['complexity_last_reason'] = $reason;
    $audit['complexity_last_note'] = $notes !== '' ? $notes : null;
    $audit['complexity_history'] = $overrideHistory;

    $patch = [
        'complexity' => $newComplexity,
        'point_value' => $newPointValue,
        'complexity_original' => $originalComplexity,
        'point_value_original' => $originalPointValue,
        'complexity_override' => $entry,
        'complexity_history' => $overrideHistory,
        'audit' => $audit,
        'timestamps' => [
            'updated_at' => $now,
        ],
        'work_history' => $history,
        'workflow' => [
            'history' => $history,
        ],
    ];

    $updated = fm_project_patch($projectId, $patch);
    if (!is_array($updated)) {
        return ['success' => false, 'error' => 'Failed to save complexity override'];
    }

    return [
        'success' => true,
        'folder' => $projectId,
        'complexity' => $newComplexity,
        'point_value' => $newPointValue,
        'override' => $entry,
        'project' => $updated,
        'manifest' => $updated,
    ];
}

function handleProjectActions($action) {
    if ($action === 'firstmeasure_reindex') {
        if (!function_exists('isAdmin') || !isAdmin()) {
            echo json_encode(['success' => false, 'ok' => false, 'error' => 'Unauthorized']);
            return true;
        }
        echo json_encode(fm_node_reindex_projects());
        return true;
    }

    if ($action === 'rush_mode_current') {
        echo json_encode(fm_rush_current());
        return true;
    }

    if ($action === 'rush_mode_list') {
        if (!function_exists('isAdmin') || !isAdmin()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }
        echo json_encode(fm_rush_admin_list());
        return true;
    }

    if ($action === 'rush_mode_start') {
        if (!function_exists('isAdmin') || !isAdmin()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }
        $duration = (int)($_POST['duration_minutes'] ?? 0);
        $startAt = trim((string)($_POST['start_at'] ?? ''));
        echo json_encode(fm_rush_admin_start($startAt, $duration));
        return true;
    }

    if ($action === 'rush_mode_automation_get') {
        if (!function_exists('isAdmin') || !isAdmin()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }
        echo json_encode(fm_rush_automation_get());
        return true;
    }

    if ($action === 'rush_mode_automation_set') {
        if (!function_exists('isAdmin') || !isAdmin()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }
        $settings = $_POST['settings'] ?? [];
        if (is_string($settings)) {
            $decoded = json_decode($settings, true);
            $settings = is_array($decoded) ? $decoded : [];
        }
        echo json_encode(fm_rush_automation_set(is_array($settings) ? $settings : []));
        return true;
    }

    if ($action === 'technician_leaderboard') {
        if (!fm_can_view_technician_leaderboard()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }
        $teamKey = trim((string)($_POST['team'] ?? $_GET['team'] ?? 'all'));
        $date = fm_leaderboard_normalize_date($_POST['date'] ?? $_GET['date'] ?? '');
        echo json_encode(fm_technician_leaderboard_for_date($teamKey, $date));
        return true;
    }

    if ($action === 'my_active_projects') {
        if (!isset($_SESSION['user_email'])) {
            echo json_encode(['success' => false, 'error' => 'Not logged in']);
            return true;
        }

        $queueMode = trim((string)($_POST['queue_mode'] ?? $_GET['queue_mode'] ?? ''));
        $projects = fm_collect_user_active_projects_fast($_SESSION['user_email'], $queueMode);
        if ($projects === null) {
            $projects = fm_collect_user_active_projects($_SESSION['user_email']);
        }

        echo json_encode([
            'success' => true,
            'projects' => $projects,
            'count' => count($projects),
        ]);
        return true;
    }

    if ($action === 'record_reopened_project_claim') {
        if (!isset($_SESSION['user_email'])) {
            echo json_encode(['success' => false, 'error' => 'Not logged in']);
            return true;
        }

        $folder = trim((string)($_POST['folder'] ?? $_POST['project_id'] ?? $_GET['folder'] ?? $_GET['project_id'] ?? ''));
        if ($folder === '') {
            echo json_encode(['success' => false, 'error' => 'Missing project id']);
            return true;
        }

        echo json_encode(fm_project_record_reopen_claim($folder, 'editor_claim'));
        return true;
    }

    if ($action === 'claim_next_for_me') {
        if (!isset($_SESSION['user_email'])) {
            echo json_encode(['success' => false, 'error' => 'Not logged in']);
            return true;
        }

        $queueMode = trim((string)($_POST['queue_mode'] ?? $_GET['queue_mode'] ?? ''));
        $projects = fm_collect_user_active_projects_fast($_SESSION['user_email'], $queueMode);
        if ($projects === null) {
            $projects = fm_collect_user_active_projects($_SESSION['user_email']);
        }
        $resume = fm_pick_resume_project($projects);
        // A successful fast lookup can still be incomplete (for example during an
        // index transition). Never claim a new queue item until the authoritative
        // project records have also been checked for resumable work.
        if (!is_array($resume) || empty($resume['id'])) {
            $projects = fm_collect_user_active_projects($_SESSION['user_email']);
            $resume = fm_pick_resume_project($projects);
        }
        if (is_array($resume) && !empty($resume['id'])) {
            $tracking = fm_project_record_reopen_claim((string)$resume['id'], 'existing_active');
            $resumeProject = (!empty($tracking['success']) && is_array($tracking['project'] ?? null)) ? $tracking['project'] : $resume;
            echo json_encode([
                'success' => true,
                'folder' => (string)$resume['id'],
                'source' => 'existing_active',
                'resumed' => true,
                'project' => $resumeProject,
                'reopen_claim_tracking' => $tracking,
            ]);
            return true;
        }

        $claim = fm_queue_claim_next($queueMode !== '' ? $queueMode : null);
        $claimJson = is_array($claim['json'] ?? null) ? $claim['json'] : [];
        $claimOk = !empty($claim['ok']) && (!array_key_exists('success', $claimJson) || !empty($claimJson['success']));
        $folder = (string)($claimJson['folder'] ?? $claimJson['id'] ?? $claimJson['project_id'] ?? '');
        if ($folder === '' && isset($claimJson['project']) && is_array($claimJson['project'])) {
            $folder = (string)($claimJson['project']['id'] ?? $claimJson['project']['folder'] ?? '');
        }
        if (!$claimOk || $folder === '') {
            echo json_encode([
                'success' => false,
                'error' => (string)($claimJson['error'] ?? $claimJson['message'] ?? 'No project available.'),
            ]);
            return true;
        }

        $tracking = fm_project_record_reopen_claim($folder, 'claim_next_for_me');
        $claimProject = (!empty($tracking['success']) && is_array($tracking['project'] ?? null)) ? $tracking['project'] : null;
        $payload = array_merge($claimJson, [
            'success' => true,
            'folder' => $folder,
            'source' => 'queue_claim',
            'resumed' => false,
            'reopen_claim_tracking' => $tracking,
        ]);
        if ($claimProject) $payload['project'] = $claimProject;
        echo json_encode($payload);
        return true;
    }

    if ($action === 'stats_data') {
        if (!isAdmin()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }

        $includeActive = filter_var($_POST['include_active'] ?? $_GET['include_active'] ?? false, FILTER_VALIDATE_BOOLEAN);
        $includeHistory = filter_var($_POST['include_history'] ?? $_GET['include_history'] ?? false, FILTER_VALIDATE_BOOLEAN);
        $page = (int)($_POST['page'] ?? $_GET['page'] ?? 1);
        $limit = (int)($_POST['limit'] ?? $_GET['limit'] ?? 150);
        if ($page < 1) $page = 1;
        if ($limit < 1) $limit = 150;
        if ($limit > 150) $limit = 150;

        $projects = [];
        $result = fm_project_list([
            'filter' => 'all',
            'status_filter' => 'all',
            'include_all' => true,
            'include_instant_only' => true,
            'view' => 'stats',
            'limit' => $limit,
            'page' => $page,
        ]);
        if (empty($result['ok'])) {
            echo json_encode(['success' => false, 'error' => 'Failed to fetch project stats data']);
            return true;
        }

        foreach (fm_as_array($result['projects'] ?? []) as $manifest) {
            if (!is_array($manifest)) continue;
            $status = strtolower(trim((string)($manifest['status'] ?? '')));
            if (!$includeActive && !in_array($status, ['completed', 'rejected', 'rejected_no_coverage'], true)) {
                continue;
            }

            $project = fm_stats_project_record($manifest, ['include_history' => $includeHistory]);
            if ($project['id'] === '') {
                continue;
            }
            $projects[] = $project;
        }

        usort($projects, function ($a, $b) {
            $aTs = fm_project_sort_ts((string)($a['completed_at'] ?? $a['created_at'] ?? ''));
            $bTs = fm_project_sort_ts((string)($b['completed_at'] ?? $b['created_at'] ?? ''));
            return $bTs <=> $aTs;
        });

        $pagination = fm_as_array($result['pagination'] ?? []);
        $totalPages = (int)($pagination['total_pages'] ?? 0);
        $totalCount = (int)($pagination['total_count'] ?? 0);
        if ($totalPages <= 0 && $totalCount > 0) $totalPages = (int)ceil($totalCount / $limit);
        if ($totalPages <= 0) $totalPages = count(fm_as_array($result['projects'] ?? [])) >= $limit ? ($page + 1) : $page;
        $hasMore = $page < $totalPages;

        echo json_encode([
            'success' => true,
            'projects' => $projects,
            'count' => count($projects),
            'source' => 'firstmeasure_api',
            'include_active' => $includeActive,
            'page' => $page,
            'limit' => $limit,
            'has_more' => $hasMore,
            'pagination' => [
                'page' => $page,
                'limit' => $limit,
                'total_pages' => $totalPages,
                'total_count' => $totalCount,
                'has_more' => $hasMore,
            ],
        ]);
        return true;
    }

    if ($action === 'manager_review_data') {
        if (!fm_can_manager_review_user()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }

        $projects = fm_fetch_manager_review_projects();
        $source = 'project_index';
        if (!is_array($projects) || count($projects) === 0) {
            $projects = fm_fetch_manager_review_projects_fallback();
            $source = 'firstmeasure_api_fallback';
        }

        echo json_encode([
            'success' => true,
            'projects' => is_array($projects) ? $projects : [],
            'count' => is_array($projects) ? count($projects) : 0,
            'source' => $source,
        ]);
        return true;
    }

    if ($action === 'manager_audit_mark') {
        if (!fm_can_manager_review_user()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }

        echo json_encode(fm_manager_audit_mark_project(
            $_POST['folder'] ?? ($_GET['folder'] ?? ''),
            $_POST['audit_status'] ?? ($_GET['audit_status'] ?? ''),
            $_POST['note'] ?? ($_GET['note'] ?? '')
        ));
        return true;
    }

    if ($action === 'manager_complexity_override') {
        if (!fm_can_manager_review_user()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }

        echo json_encode(fm_manager_override_project_complexity(
            $_POST['folder'] ?? ($_GET['folder'] ?? ''),
            $_POST['complexity'] ?? ($_GET['complexity'] ?? ''),
            $_POST['reason'] ?? ($_GET['reason'] ?? ''),
            $_POST['notes'] ?? ($_GET['notes'] ?? '')
        ));
        return true;
    }

    return false;
}
