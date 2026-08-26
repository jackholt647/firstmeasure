<?php
require_once __DIR__ . '/_storage.php';
require_once __DIR__ . '/firstmeasure_node.php';

if (defined('FIRSTMEASURE_TUTORIALS_LOADED')) {
    return;
}
define('FIRSTMEASURE_TUTORIALS_LOADED', true);
define('FIRSTMEASURE_TUTORIAL_GRADING_VERSION', 5);
define('FIRSTMEASURE_TUTORIAL_ANSWER_KEY_VERSION', 3);

function fm_tutorial_course_id_from_request() {
    $raw = strtolower(trim((string)($_POST['course_id'] ?? $_GET['course_id'] ?? 'default')));
    if ($raw === '' || $raw === 'default') return 'default';
    $slug = preg_replace('/[^a-z0-9_\-]/', '', str_replace(' ', '-', $raw));
    return $slug !== '' ? $slug : 'default';
}

function fm_tutorial_safe_user($email) {
    $safe = preg_replace('/[^a-zA-Z0-9_\-@\.]/', '_', strtolower(trim((string)$email)));
    return $safe !== '' ? $safe : 'anonymous';
}

function fm_tutorial_root() {
    return storageDir('tutorials');
}

function fm_tutorial_course_base_dir($courseId) {
    $courseId = (string)$courseId;
    if ($courseId === '' || $courseId === 'default') return fm_tutorial_root();
    return storageDir('tutorials/courses/' . $courseId);
}

function fm_tutorial_course_master_dir($courseId) {
    $dir = fm_tutorial_course_base_dir($courseId) . 'master/';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    return $dir;
}

function fm_tutorial_user_course_dir($courseId, $userEmail) {
    $safeUser = fm_tutorial_safe_user($userEmail);
    $courseId = (string)$courseId;
    $dir = storageDir('tutorials/users/' . $safeUser . '/courses/' . ($courseId ?: 'default'));
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    return $dir;
}

function fm_tutorial_user_projects_dir($courseId, $userEmail) {
    $dir = fm_tutorial_user_course_dir($courseId, $userEmail) . 'projects/';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    return $dir;
}

function fm_tutorial_progress_file($courseId, $userEmail) {
    return fm_tutorial_user_course_dir($courseId, $userEmail) . 'progress.json';
}

function fm_tutorial_legacy_progress_file($courseId, $userEmail) {
    $safeUser = fm_tutorial_safe_user($userEmail);
    return fm_tutorial_course_base_dir($courseId) . $safeUser . '/progress.json';
}

function fm_tutorial_default_progress() {
    return [
        'completed_videos' => [],
        'completed_projects' => [],
        'current_chapter' => 1,
        'test_attempts' => []
    ];
}

function fm_tutorial_read_json_file($path, $fallback = []) {
    if (!is_string($path) || $path === '' || !is_file($path)) return $fallback;
    $data = json_decode((string)@file_get_contents($path), true);
    return is_array($data) ? $data : $fallback;
}

function fm_tutorial_write_json_file($path, $data) {
    $dir = dirname($path);
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if (!is_string($json)) return false;
    $written = @file_put_contents($path, $json, LOCK_EX);
    if ($written === false) {
        // Some shared/container storage drivers do not support flock(). The
        // caller still performs an immediate read-back verification.
        $written = @file_put_contents($path, $json);
    }
    return $written !== false;
}

function fm_tutorial_read_progress($courseId, $userEmail) {
    $progress = fm_tutorial_read_json_file(fm_tutorial_progress_file($courseId, $userEmail), null);
    if (!is_array($progress)) {
        $progress = fm_tutorial_read_json_file(fm_tutorial_legacy_progress_file($courseId, $userEmail), fm_tutorial_default_progress());
    }
    $progress = array_merge(fm_tutorial_default_progress(), $progress);
    if (!is_array($progress['completed_videos'])) $progress['completed_videos'] = [];
    if (!is_array($progress['completed_projects'])) $progress['completed_projects'] = [];
    if (!is_array($progress['test_attempts'] ?? null)) $progress['test_attempts'] = [];
    $progress['current_chapter'] = max(1, (int)($progress['current_chapter'] ?? 1));
    return $progress;
}

function fm_tutorial_write_progress($courseId, $userEmail, $progress) {
    $progress = is_array($progress) ? $progress : fm_tutorial_default_progress();
    return fm_tutorial_write_json_file(fm_tutorial_progress_file($courseId, $userEmail), $progress);
}

function fm_tutorial_sanitize_project_id($projectId) {
    return preg_replace('/[^a-zA-Z0-9_\-]/', '', trim((string)$projectId));
}

function fm_tutorial_is_tutorial_project_id($projectId) {
    return preg_match('/^tutorial_[a-f0-9]{16,64}$/', (string)$projectId) === 1;
}

function fm_tutorial_sanitize_file_name($name, $fallback = 'file.bin') {
    $name = basename(str_replace('\\', '/', (string)$name));
    $name = preg_replace('/[^a-zA-Z0-9._\-]/', '_', $name);
    $name = trim($name, '._');
    return $name !== '' ? $name : $fallback;
}

function fm_tutorial_project_dir($courseId, $userEmail, $tutorialId) {
    $tutorialId = fm_tutorial_sanitize_project_id($tutorialId);
    if (!fm_tutorial_is_tutorial_project_id($tutorialId)) return null;
    return fm_tutorial_user_projects_dir($courseId, $userEmail) . $tutorialId . '/';
}

function fm_tutorial_project_manifest_file($courseId, $userEmail, $tutorialId) {
    $dir = fm_tutorial_project_dir($courseId, $userEmail, $tutorialId);
    return $dir ? $dir . 'manifest.json' : null;
}

function fm_tutorial_project_artifacts_dir($courseId, $userEmail, $tutorialId) {
    $dir = fm_tutorial_project_dir($courseId, $userEmail, $tutorialId);
    if (!$dir) return null;
    $artifacts = $dir . 'artifacts/';
    if (!is_dir($artifacts)) @mkdir($artifacts, 0775, true);
    return $artifacts;
}

function fm_tutorial_new_id($courseId, $userEmail) {
    for ($i = 0; $i < 5; $i++) {
        $id = 'tutorial_' . bin2hex(random_bytes(12));
        if (!is_dir(fm_tutorial_user_projects_dir($courseId, $userEmail) . $id)) return $id;
    }
    return 'tutorial_' . bin2hex(random_bytes(16));
}

function fm_tutorial_curriculum_file($courseId) {
    return fm_tutorial_course_master_dir($courseId) . 'curriculum.json';
}

function fm_tutorial_read_curriculum($courseId) {
    $curriculum = fm_tutorial_read_json_file(fm_tutorial_curriculum_file($courseId), ['chapters' => []]);
    if (!is_array($curriculum)) $curriculum = ['chapters' => []];
    if (!is_array($curriculum['chapters'] ?? null)) $curriculum['chapters'] = [];
    return $curriculum;
}

function fm_tutorial_source_id_from_project($project) {
    if (!is_array($project)) return '';
    return fm_tutorial_sanitize_project_id($project['project_id'] ?? $project['source_project_id'] ?? $project['id'] ?? '');
}

function fm_tutorial_chapter_project_list($chapter, $forTest = false) {
    if (!is_array($chapter)) return [];
    $raw = $forTest
        ? ($chapter['test_projects'] ?? $chapter['test_pool'] ?? (((($chapter['mode'] ?? $chapter['chapter_type'] ?? '') === 'test') ? ($chapter['projects'] ?? []) : [])))
        : ($chapter['projects'] ?? []);
    if (!is_array($raw)) return [];
    $out = [];
    $seen = [];
    foreach ($raw as $project) {
        $sourceId = fm_tutorial_source_id_from_project($project);
        if ($sourceId === '' || isset($seen[$sourceId])) continue;
        $seen[$sourceId] = true;
        $entry = is_array($project) ? $project : [];
        $entry['source_project_id'] = $sourceId;
        if (!empty($entry['curriculum_project_id'])) {
            $entry['curriculum_project_id'] = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)$entry['curriculum_project_id']);
        }
        $out[] = $entry;
    }
    return $out;
}

function fm_tutorial_normalize_decision($value) {
    $raw = strtolower(trim((string)$value));
    if (in_array($raw, ['draft', 'drafted', 'approve', 'approved', 'accept', 'accepted'], true)) return 'draft';
    if (in_array($raw, ['reject', 'rejected', 'deny', 'denied'], true)) return 'reject';
    return '';
}

function fm_tutorial_project_entry_key($project) {
    if (!is_array($project)) return '';
    $itemId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($project['curriculum_project_id'] ?? $project['practice_project_id'] ?? ''));
    if ($itemId !== '') return 'item:' . $itemId;
    $sourceId = fm_tutorial_source_id_from_project($project);
    return $sourceId !== '' ? 'source:' . $sourceId : '';
}

function fm_tutorial_normalize_draft_reject_rounds($chapter) {
    if (!is_array($chapter)) return [];
    $rawRounds = is_array($chapter['draft_reject_rounds'] ?? null) ? $chapter['draft_reject_rounds'] : [];
    if (!$rawRounds && !empty($chapter['draft_reject_projects'])) {
        $rawRounds[] = [
            'id' => 'draft_reject_1',
            'title' => $chapter['draft_reject_title'] ?? 'Draft or Reject',
            'mode' => $chapter['draft_reject_mode'] ?? 'practice',
            'projects' => $chapter['draft_reject_projects'],
            'sample_count' => $chapter['draft_reject_sample_count'] ?? 5,
            'passing_score_percent' => $chapter['draft_reject_passing_score_percent'] ?? 80,
            'required' => $chapter['draft_reject_required'] ?? false,
            'retake_wait_hours' => $chapter['draft_reject_retake_wait_hours'] ?? 24,
        ];
    }

    $rounds = [];
    foreach ($rawRounds as $idx => $round) {
        if (!is_array($round)) continue;
        $id = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($round['id'] ?? ('draft_reject_' . ($idx + 1))));
        if ($id === '') $id = 'draft_reject_' . ($idx + 1);
        $projects = [];
        foreach ((array)($round['projects'] ?? $round['project_pool'] ?? []) as $project) {
            $sourceId = fm_tutorial_source_id_from_project($project);
            if ($sourceId === '') continue;
            $entry = is_array($project) ? $project : [];
            $entry['source_project_id'] = $sourceId;
            $entry['correct_decision'] = fm_tutorial_normalize_decision($entry['correct_decision'] ?? $entry['answer'] ?? $entry['expected_decision'] ?? 'draft') ?: 'draft';
            if (!empty($entry['curriculum_project_id'])) {
                $entry['curriculum_project_id'] = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)$entry['curriculum_project_id']);
            }
            $projects[] = $entry;
        }
        $rounds[] = [
            'id' => $id,
            'title' => trim((string)($round['title'] ?? ('Draft or Reject ' . ($idx + 1)))) ?: ('Draft or Reject ' . ($idx + 1)),
            'mode' => (($round['mode'] ?? 'practice') === 'test') ? 'test' : 'practice',
            'projects' => $projects,
            'sample_count' => max(1, (int)($round['sample_count'] ?? 5)),
            'passing_score_percent' => max(0, min(100, (int)($round['passing_score_percent'] ?? 80))),
            'required' => ($round['required'] ?? false) === true,
            'retake_wait_hours' => max(0, (int)($round['retake_wait_hours'] ?? 24)),
        ];
    }
    return $rounds;
}

function fm_tutorial_normalize_test_sections($chapter) {
    if (!is_array($chapter)) return [];
    $rawTests = is_array($chapter['tests'] ?? null) ? $chapter['tests'] : [];
    if (!$rawTests) {
        $legacyPool = $chapter['test_projects'] ?? $chapter['test_pool'] ?? [];
        $legacyEnabled = !empty($chapter['test_enabled'])
            || !empty($chapter['has_test'])
            || !empty($chapter['is_test'])
            || (($chapter['mode'] ?? $chapter['chapter_type'] ?? '') === 'test')
            || !empty($legacyPool);
        if ($legacyEnabled) {
            $rawTests[] = [
                'id' => 'test_1',
                'title' => $chapter['test_title'] ?? 'Test',
                'projects' => $legacyPool,
                'sample_count' => $chapter['test']['sample_count'] ?? $chapter['sample_count'] ?? 5,
                'time_limit_minutes' => $chapter['test']['time_limit_minutes'] ?? $chapter['time_limit_minutes'] ?? 120,
                'passing_score_percent' => $chapter['test']['passing_score_percent'] ?? $chapter['passing_score_percent'] ?? 80,
                'required' => $chapter['test']['required'] ?? $chapter['test_required'] ?? false,
                'retakeable' => $chapter['test']['retakeable'] ?? $chapter['retakeable'] ?? true,
                'retake_wait_hours' => $chapter['test']['retake_wait_hours'] ?? $chapter['retake_wait_hours'] ?? 24
            ];
        }
    }

    $tests = [];
    foreach ($rawTests as $idx => $test) {
        if (!is_array($test)) continue;
        $id = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($test['id'] ?? ('test_' . ($idx + 1))));
        if ($id === '') $id = 'test_' . ($idx + 1);
        $projects = $test['projects'] ?? $test['test_projects'] ?? $test['test_pool'] ?? [];
        $tests[] = [
            'id' => $id,
            'title' => trim((string)($test['title'] ?? ('Test ' . ($idx + 1)))) ?: ('Test ' . ($idx + 1)),
            'projects' => is_array($projects) ? $projects : [],
            'sample_count' => max(1, (int)($test['sample_count'] ?? 5)),
            'time_limit_minutes' => max(0, (int)($test['time_limit_minutes'] ?? 120)),
            'passing_score_percent' => max(0, min(100, (int)($test['passing_score_percent'] ?? 80))),
            'required' => ($test['required'] ?? false) === true,
            'retakeable' => ($test['retakeable'] ?? true) !== false,
            'retake_wait_hours' => max(0, (int)($test['retake_wait_hours'] ?? 24)),
        ];
    }
    return $tests;
}

function fm_tutorial_find_test_section($chapter, $testId = null) {
    $tests = fm_tutorial_normalize_test_sections($chapter);
    if (!$tests) return null;
    $testId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)$testId);
    if ($testId !== '') {
        foreach ($tests as $test) {
            if (($test['id'] ?? '') === $testId) return $test;
        }
    }
    return $tests[0];
}

function fm_tutorial_test_attempt_passed($attempt, $test) {
    if (!is_array($attempt)) return false;
    if (($attempt['passed'] ?? null) === true) return true;
    $score = is_numeric($attempt['final_score'] ?? null) ? (float)$attempt['final_score'] : null;
    if ($score === null) return false;
    $passing = max(0, min(100, (float)($attempt['passing_score_percent'] ?? $test['passing_score_percent'] ?? 80)));
    return $score >= $passing;
}

function fm_tutorial_required_tests_passed($chapter, $progress, $chapterId) {
    $tests = fm_tutorial_normalize_test_sections($chapter);
    $attempts = is_array($progress['test_attempts'] ?? null) ? $progress['test_attempts'] : [];
    foreach ($tests as $test) {
        if (empty($test['required'])) continue;
        $passed = false;
        foreach ($attempts as $attempt) {
            if (!is_array($attempt)) continue;
            if (($attempt['type'] ?? '') === 'draft_reject') continue;
            if ((string)($attempt['chapter_id'] ?? '') !== (string)$chapterId) continue;
            if ((string)($attempt['test_id'] ?? 'test_1') !== (string)($test['id'] ?? 'test_1')) continue;
            if (fm_tutorial_test_attempt_passed($attempt, $test)) {
                $passed = true;
                break;
            }
        }
        if (!$passed) return false;
    }
    return true;
}

function fm_tutorial_required_draft_reject_rounds_passed($chapter, $progress, $chapterId) {
    $rounds = fm_tutorial_normalize_draft_reject_rounds($chapter);
    $attempts = is_array($progress['test_attempts'] ?? null) ? $progress['test_attempts'] : [];
    foreach ($rounds as $round) {
        if (empty($round['required']) || ($round['mode'] ?? 'practice') !== 'test') continue;
        $passed = false;
        foreach ($attempts as $attempt) {
            if (!is_array($attempt)) continue;
            if (($attempt['type'] ?? '') !== 'draft_reject') continue;
            if ((string)($attempt['chapter_id'] ?? '') !== (string)$chapterId) continue;
            if ((string)($attempt['round_id'] ?? '') !== (string)($round['id'] ?? '')) continue;
            if (fm_tutorial_test_attempt_passed($attempt, ['passing_score_percent' => $round['passing_score_percent'] ?? 80])) {
                $passed = true;
                break;
            }
        }
        if (!$passed) return false;
    }
    return true;
}

function fm_tutorial_source_manifest_subset($sourceManifest, $tutorialManifest) {
    $sourceManifest = is_array($sourceManifest) ? $sourceManifest : [];
    $tutorialManifest = is_array($tutorialManifest) ? $tutorialManifest : [];
    $keys = [
        'address',
        'lat',
        'lng',
        'pins',
        'radius_meters',
        'complexity',
        'point_value',
        'project_type',
        'include_gutter_measurements',
        'components',
        'is_custom_pin',
        'instant_enabled',
        'instant_only',
        'artifacts'
    ];
    $out = [];
    foreach ($keys as $key) {
        if (array_key_exists($key, $sourceManifest)) $out[$key] = $sourceManifest[$key];
    }
    $out['id'] = $tutorialManifest['id'] ?? '';
    $out['folder'] = $out['id'];
    $out['project_id'] = $out['id'];
    $out['status'] = $tutorialManifest['status'] ?? 'tutorial_in_progress';
    $out['is_tutorial_instance'] = true;
    $out['tutorial_mode'] = true;
    $out['tutorial_course_id'] = $tutorialManifest['tutorial_course_id'] ?? 'default';
    $out['source_project_id'] = $tutorialManifest['source_project_id'] ?? '';
    $out['original_master_id'] = $out['source_project_id'];
    $out['owner_email'] = $tutorialManifest['owner_email'] ?? '';
    $out['created_at'] = $tutorialManifest['created_at'] ?? null;
    $out['completed_at'] = $tutorialManifest['completed_at'] ?? null;
    $out['tutorial_progress'] = $tutorialManifest['tutorial_progress'] ?? [];
    $out['chapter_id'] = $tutorialManifest['chapter_id'] ?? null;
    $out['tutorial_kind'] = $tutorialManifest['tutorial_kind'] ?? 'practice';
    $out['curriculum_project_id'] = $tutorialManifest['curriculum_project_id'] ?? null;
    $out['practice_project_name'] = $tutorialManifest['practice_project_name'] ?? null;
    $out['test_attempt_id'] = $tutorialManifest['test_attempt_id'] ?? null;
    $out['test_sequence_index'] = $tutorialManifest['test_sequence_index'] ?? null;
    $out['test_sequence_total'] = $tutorialManifest['test_sequence_total'] ?? null;
    $out['test_started_at'] = $tutorialManifest['test_started_at'] ?? null;
    $out['test_due_at'] = $tutorialManifest['test_due_at'] ?? null;
    $out['draft_reject_attempt_id'] = $tutorialManifest['draft_reject_attempt_id'] ?? null;
    $out['draft_reject_round_id'] = $tutorialManifest['draft_reject_round_id'] ?? null;
    $out['draft_reject_title'] = $tutorialManifest['draft_reject_title'] ?? null;
    $out['draft_reject_mode'] = $tutorialManifest['draft_reject_mode'] ?? null;
    $out['draft_reject_expected_decision'] = $tutorialManifest['draft_reject_expected_decision'] ?? null;
    $out['draft_reject_decision'] = $tutorialManifest['draft_reject_decision'] ?? null;
    $out['draft_reject_rejection_reason'] = $tutorialManifest['draft_reject_rejection_reason'] ?? null;
    $out['draft_reject_sequence_index'] = $tutorialManifest['draft_reject_sequence_index'] ?? null;
    $out['draft_reject_sequence_total'] = $tutorialManifest['draft_reject_sequence_total'] ?? null;
    $out['draft_reject_started_at'] = $tutorialManifest['draft_reject_started_at'] ?? null;
    return $out;
}

function fm_tutorial_editor_action_url($action, $params = []) {
    $query = array_merge(['action' => $action], $params);
    return 'editor.php?' . http_build_query($query);
}

function fm_tutorial_artifact_url($tutorialId, $fileName, $courseId = null) {
    $params = [
        'tutorial_id' => fm_tutorial_sanitize_project_id($tutorialId),
        'name' => fm_tutorial_sanitize_file_name($fileName)
    ];
    if ($courseId !== null) $params['course_id'] = $courseId;
    return fm_tutorial_editor_action_url('tutorial_project_artifact', $params);
}

function fm_tutorial_list_artifacts($courseId, $userEmail, $tutorialId) {
    $dir = fm_tutorial_project_artifacts_dir($courseId, $userEmail, $tutorialId);
    if (!$dir || !is_dir($dir)) return [];
    $files = [];
    foreach (scandir($dir) ?: [] as $name) {
        if ($name === '.' || $name === '..') continue;
        $path = $dir . $name;
        if (!is_file($path)) continue;
        $files[] = [
            'name' => $name,
            'size' => filesize($path),
            'mtime' => filemtime($path),
            'url' => fm_tutorial_artifact_url($tutorialId, $name, $courseId)
        ];
    }
    return $files;
}

function fm_tutorial_truthy_asset($value) {
    if (is_bool($value)) return $value;
    if (is_numeric($value)) return (float)$value != 0.0;
    if (is_string($value)) return trim($value) !== '';
    if (is_array($value)) return !empty($value);
    return false;
}

function fm_tutorial_number_or_null($value) {
    return is_numeric($value) ? (float)$value : null;
}

function fm_tutorial_metric_map($value, $normalizer = null) {
    $out = [];
    if (!is_array($value)) return $out;
    foreach ($value as $key => $raw) {
        $num = fm_tutorial_number_or_null($raw);
        if ($num === null) continue;
        $label = trim((string)$key);
        if ($label === '') $label = 'unlabeled';
        if (is_callable($normalizer)) {
            $label = (string)$normalizer($label);
            if ($label === '') continue;
        }
        $out[$label] = ($out[$label] ?? 0.0) + $num;
    }
    ksort($out);
    return $out;
}

function fm_tutorial_normalize_line_type($type) {
    $key = strtolower(trim((string)$type));
    $key = preg_replace('/[^a-z0-9]+/', '_', $key);
    $key = trim((string)$key, '_');
    $aliases = [
        'ridges' => 'ridge',
        'hips' => 'hip',
        'valleys' => 'valley',
        'rakes' => 'rake',
        'eaves' => 'eave',
        'headwall' => 'head_wall',
        'head_walls' => 'head_wall',
        'sidewall' => 'side_wall',
        'side_walls' => 'side_wall',
        'step' => 'step_flashing',
        'step_flashings' => 'step_flashing',
        'parapet_wall' => 'parapet',
        'parapet_walls' => 'parapet',
        'transitions' => 'transition'
    ];
    $key = $aliases[$key] ?? $key;
    $roofTypes = [
        'ridge' => true,
        'hip' => true,
        'valley' => true,
        'rake' => true,
        'eave' => true,
        'transition' => true,
        'head_wall' => true,
        'side_wall' => true,
        'step_flashing' => true,
        'parapet' => true
    ];
    return isset($roofTypes[$key]) ? $key : '';
}

function fm_tutorial_normalize_pitch_label($pitch) {
    $label = strtolower(trim((string)$pitch));
    $label = str_replace([' ', ':'], ['', '/'], $label);
    if (preg_match('/^-?\d+(?:\.\d+)?$/', $label)) {
        $label .= '/12';
    }
    if (preg_match('/^(-?\d+(?:\.\d+)?)\/(?:12(?:\.0+)?)$/', $label, $m)) {
        $rise = (float)$m[1];
        $rounded = (abs($rise - round($rise)) < 0.001) ? (string)((int)round($rise)) : rtrim(rtrim((string)round($rise, 2), '0'), '.');
        return $rounded . '/12';
    }
    return $label !== '' ? $label : 'unlabeled';
}

function fm_tutorial_pitch_rise_from_label($pitch) {
    $label = fm_tutorial_normalize_pitch_label($pitch);
    if (preg_match('/^(-?\d+(?:\.\d+)?)\/12$/', $label, $m)) return (float)$m[1];
    return null;
}

function fm_tutorial_line_lengths_from_report($report) {
    $materials = is_array($report['materials'] ?? null) ? $report['materials'] : [];
    $linear = fm_tutorial_metric_map($materials['linear'] ?? [], 'fm_tutorial_normalize_line_type');
    if ($linear) return $linear;

    $out = [];
    foreach (($report['lines'] ?? []) as $line) {
        if (!is_array($line)) continue;
        $type = fm_tutorial_normalize_line_type($line['type'] ?? ($line['conn']['type'] ?? ''));
        if ($type === '') continue;
        $length = fm_tutorial_number_or_null($line['length'] ?? null);
        if ($length === null) continue;
        $out[$type] = ($out[$type] ?? 0.0) + $length;
    }
    ksort($out);
    return $out;
}

function fm_tutorial_pitch_areas_from_report($report) {
    $materials = is_array($report['materials'] ?? null) ? $report['materials'] : [];
    $squares = fm_tutorial_metric_map($materials['squares'] ?? [], 'fm_tutorial_normalize_pitch_label');
    $out = [];
    foreach ($squares as $pitch => $value) {
        $label = fm_tutorial_normalize_pitch_label($pitch);
        $out[$label] = ($out[$label] ?? 0.0) + ((float)$value * 100.0);
    }
    ksort($out);
    return $out;
}

function fm_tutorial_polygon_area_px($points) {
    if (!is_array($points) || count($points) < 3) return 0.0;
    $area = 0.0;
    $count = count($points);
    for ($i = 0; $i < $count; $i++) {
        $p1 = $points[$i];
        $p2 = $points[($i + 1) % $count];
        $area += ((float)($p1['x'] ?? 0)) * ((float)($p2['y'] ?? 0));
        $area -= ((float)($p2['x'] ?? 0)) * ((float)($p1['y'] ?? 0));
    }
    return abs($area * 0.5);
}

function fm_tutorial_fit_face_plane($points) {
    if (!is_array($points) || count($points) < 3) return null;
    $n = 0;
    $sx = $sy = $sz = $sxx = $syy = $sxy = $sxz = $syz = 0.0;
    foreach ($points as $p) {
        if (!is_array($p) || !is_numeric($p['x'] ?? null) || !is_numeric($p['y'] ?? null) || !is_numeric($p['z'] ?? null)) continue;
        $x = (float)$p['x'];
        $y = (float)$p['y'];
        $z = (float)$p['z'];
        $n++;
        $sx += $x;
        $sy += $y;
        $sz += $z;
        $sxx += $x * $x;
        $syy += $y * $y;
        $sxy += $x * $y;
        $sxz += $x * $z;
        $syz += $y * $z;
    }
    if ($n < 3) return null;

    $det = $sxx * ($syy * $n - $sy * $sy)
        - $sxy * ($sxy * $n - $sy * $sx)
        + $sx * ($sxy * $sy - $syy * $sx);
    if (abs($det) < 0.000001) return null;

    $aDet = $sxz * ($syy * $n - $sy * $sy)
        - $sxy * ($syz * $n - $sy * $sz)
        + $sx * ($syz * $sy - $syy * $sz);
    $bDet = $sxx * ($syz * $n - $sy * $sz)
        - $sxz * ($sxy * $n - $sy * $sx)
        + $sx * ($sxy * $sz - $syz * $sx);

    return [
        'a' => $aDet / $det,
        'b' => $bDet / $det
    ];
}

function fm_tutorial_face_pitch_rise($face, $metersPerPx) {
    $metersPerPx = (float)$metersPerPx;
    if ($metersPerPx <= 0) return 0.0;
    $plane = is_array($face['plane'] ?? null) ? $face['plane'] : [];
    if ((!is_numeric($plane['a'] ?? null) || !is_numeric($plane['b'] ?? null)) && is_array($face['points'] ?? null)) {
        $plane = fm_tutorial_fit_face_plane($face['points']) ?: [];
    }
    $a = fm_tutorial_number_or_null($plane['a'] ?? null);
    $b = fm_tutorial_number_or_null($plane['b'] ?? null);
    if ($a === null || $b === null) return 0.0;
    return abs(sqrt(($a * $a) + ($b * $b)) * (1.0 / $metersPerPx) * 12.0);
}

function fm_tutorial_get_meters_per_px($metadata, $pdfState) {
    $metadata = is_array($metadata) ? $metadata : [];
    $pdfState = is_array($pdfState) ? $pdfState : [];
    $metersPerPx = fm_tutorial_number_or_null($metadata['imageMetersPerPx'] ?? ($pdfState['imageMetersPerPx'] ?? null));
    if ($metersPerPx !== null && $metersPerPx > 0) return $metersPerPx;

    $radius = fm_tutorial_number_or_null($pdfState['radiusMeters'] ?? ($metadata['radiusMeters'] ?? null));
    if ($radius === null || $radius <= 0) {
        $radius = fm_tutorial_number_or_null($metadata['layer_config']['__radius']['scale'] ?? null);
    }
    $dims = is_array($pdfState['dims'] ?? null) ? $pdfState['dims'] : [];
    $width = fm_tutorial_number_or_null($metadata['imageWidth'] ?? ($dims['w'] ?? null));
    if ($radius !== null && $radius > 0 && $width !== null && $width > 0) {
        return ($radius * 2.0) / $width;
    }
    return null;
}

function fm_tutorial_geometry_has_drawn_data($geometry) {
    return is_array($geometry)
        && (is_array($geometry['points'] ?? null) || is_array($geometry['connections'] ?? null) || is_array($geometry['resolvedFaces'] ?? null) || is_array($geometry['manualFaces'] ?? null));
}

function fm_tutorial_best_geometry($metadata, $pdfState) {
    $metadata = is_array($metadata) ? $metadata : [];
    $pdfState = is_array($pdfState) ? $pdfState : [];
    $metaGeometry = $metadata['geometry'] ?? null;
    $pdfGeometry = $pdfState['geometry'] ?? null;
    $metaScore = fm_tutorial_geometry_richness_score($metaGeometry, $pdfState);
    $pdfScore = fm_tutorial_geometry_richness_score($pdfGeometry, $pdfState);
    if ($metaScore <= 0 && $pdfScore <= 0) return [];
    if ($pdfScore > $metaScore) return $pdfGeometry;
    if (fm_tutorial_geometry_has_drawn_data($metaGeometry)) return $metaGeometry;
    if (fm_tutorial_geometry_has_drawn_data($pdfGeometry)) return $pdfGeometry;
    return [];
}

function fm_tutorial_geometry_richness_score($geometry, $pdfState = []) {
    if (!fm_tutorial_geometry_has_drawn_data($geometry)) return 0;
    $geometry = is_array($geometry) ? $geometry : [];
    $score = 0;
    $score += is_array($geometry['points'] ?? null) ? count($geometry['points']) : 0;
    $score += is_array($geometry['connections'] ?? null) ? count($geometry['connections']) * 2 : 0;
    foreach (['resolvedFaces', 'manualFaces'] as $key) {
        $score += is_array($geometry[$key] ?? null) ? count($geometry[$key]) * 5 : 0;
    }
    if (($pdfState['geometry'] ?? null) === $geometry && is_array($pdfState['facesData'] ?? null)) {
        $score += count($pdfState['facesData']) * 5;
    }
    return $score;
}

function fm_tutorial_geometry_face_points($face, $points) {
    if (!is_array($face)) return [];
    if (is_array($face['points'] ?? null) && count($face['points']) >= 3) return $face['points'];
    $indexes = is_array($face['pointIndices'] ?? null) ? $face['pointIndices'] : [];
    $out = [];
    foreach ($indexes as $idx) {
        if (!is_numeric($idx)) continue;
        $i = (int)$idx;
        if (is_array($points[$i] ?? null)) $out[] = $points[$i];
    }
    return $out;
}

function fm_tutorial_geometry_faces($geometry, $pdfState) {
    $geometry = is_array($geometry) ? $geometry : [];
    $points = is_array($geometry['points'] ?? null) ? $geometry['points'] : [];
    $faces = [];
    foreach (['resolvedFaces', 'manualFaces'] as $key) {
        if (!is_array($geometry[$key] ?? null)) continue;
        foreach ($geometry[$key] as $face) {
            $facePoints = fm_tutorial_geometry_face_points($face, $points);
            if (count($facePoints) < 3) continue;
            $copy = is_array($face) ? $face : [];
            $copy['points'] = $facePoints;
            $faces[] = $copy;
        }
    }
    if (!$faces && is_array($pdfState['facesData'] ?? null)) $faces = $pdfState['facesData'];
    return $faces;
}

function fm_tutorial_connection_points($conn, $points) {
    if (!is_array($conn)) return null;
    $start = is_array($conn['start'] ?? null) ? $conn['start'] : null;
    $end = is_array($conn['end'] ?? null) ? $conn['end'] : null;
    if (!$start && is_numeric($conn['startIdx'] ?? null)) $start = $points[(int)$conn['startIdx']] ?? null;
    if (!$end && is_numeric($conn['endIdx'] ?? null)) $end = $points[(int)$conn['endIdx']] ?? null;
    if (!is_array($start) || !is_array($end)) return null;
    return [$start, $end];
}

function fm_tutorial_geometry_line_lengths($geometry, $metersPerPx) {
    $geometry = is_array($geometry) ? $geometry : [];
    $points = is_array($geometry['points'] ?? null) ? $geometry['points'] : [];
    $connections = is_array($geometry['connections'] ?? null) ? $geometry['connections'] : [];
    $metersPerPx = (float)$metersPerPx;
    if ($metersPerPx <= 0 || !$connections) return [];
    $out = [];
    foreach ($connections as $conn) {
        $type = fm_tutorial_normalize_line_type($conn['type'] ?? '');
        if ($type === '') continue;
        $pair = fm_tutorial_connection_points($conn, $points);
        if (!$pair) continue;
        [$p1, $p2] = $pair;
        $dx = (((float)($p2['x'] ?? 0)) - ((float)($p1['x'] ?? 0))) * $metersPerPx;
        $dy = (((float)($p2['y'] ?? 0)) - ((float)($p1['y'] ?? 0))) * $metersPerPx;
        $z1 = fm_tutorial_number_or_null($p1['z'] ?? null) ?? 0.0;
        $z2 = fm_tutorial_number_or_null($p2['z'] ?? null) ?? 0.0;
        $dz = $z1 - $z2;
        $lengthFeet = sqrt(($dx * $dx) + ($dy * $dy) + ($dz * $dz)) * 3.28084;
        if ($lengthFeet <= 0.001) continue;
        $out[$type] = ($out[$type] ?? 0.0) + $lengthFeet;
    }
    ksort($out);
    return $out;
}

function fm_tutorial_geometry_area_metrics($faces, $metersPerPx) {
    $metersPerPx = (float)$metersPerPx;
    if (!is_array($faces) || !$faces || $metersPerPx <= 0) return null;
    $pitchAreas = [];
    $totalSqFt = 0.0;
    $facetCount = 0;
    foreach ($faces as $face) {
        if (!is_array($face)) continue;
        $points = is_array($face['points'] ?? null) ? $face['points'] : [];
        if (count($points) < 3) continue;
        $areaPx = fm_tutorial_polygon_area_px($points);
        if (is_array($face['holes'] ?? null)) {
            foreach ($face['holes'] as $hole) {
                if (is_array($hole)) $areaPx -= fm_tutorial_polygon_area_px($hole);
            }
        }
        if ($areaPx <= 2.0) continue;
        $facetCount++;
        $rise = fm_tutorial_face_pitch_rise($face, $metersPerPx);
        $pitchDeg = atan($rise / 12.0);
        $cos = cos($pitchDeg);
        if ($cos <= 0.000001) $cos = 1.0;
        $areaSqFt = (($areaPx * $metersPerPx * $metersPerPx) / $cos) * 10.7639;
        $pitchLabel = ((int)round($rise)) . '/12';
        $pitchAreas[$pitchLabel] = ($pitchAreas[$pitchLabel] ?? 0.0) + $areaSqFt;
        $totalSqFt += $areaSqFt;
    }
    if ($facetCount <= 0 || $totalSqFt <= 0) return null;
    ksort($pitchAreas);
    return [
        'facet_count' => $facetCount,
        'area_sq_ft' => $totalSqFt,
        'pitch_area_sq_ft_by_label' => $pitchAreas
    ];
}

function fm_tutorial_recalculate_geometry_score_metrics($metadata, $pdfState) {
    $metadata = is_array($metadata) ? $metadata : [];
    $pdfState = is_array($pdfState) ? $pdfState : [];
    $geometry = fm_tutorial_best_geometry($metadata, $pdfState);
    if (!fm_tutorial_geometry_has_drawn_data($geometry)) return null;
    $metersPerPx = fm_tutorial_get_meters_per_px($metadata, $pdfState);
    if ($metersPerPx === null || $metersPerPx <= 0) return null;

    $faces = fm_tutorial_geometry_faces($geometry, $pdfState);
    $areaMetrics = fm_tutorial_geometry_area_metrics($faces, $metersPerPx);
    $lineLengths = fm_tutorial_geometry_line_lengths($geometry, $metersPerPx);
    if (!$areaMetrics && !$lineLengths) return null;

    return [
        'facet_count' => is_array($areaMetrics) ? (int)$areaMetrics['facet_count'] : 0,
        'area_sq_ft' => is_array($areaMetrics) ? (float)$areaMetrics['area_sq_ft'] : 0.0,
        'line_lengths_by_type' => $lineLengths,
        'pitch_area_sq_ft_by_label' => is_array($areaMetrics) ? $areaMetrics['pitch_area_sq_ft_by_label'] : []
    ];
}

function fm_tutorial_recalculate_face_area_metrics($pdfState) {
    $pdfState = is_array($pdfState) ? $pdfState : [];
    $faces = is_array($pdfState['facesData'] ?? null) ? $pdfState['facesData'] : [];
    if (!$faces) return null;

    $metersPerPx = fm_tutorial_number_or_null($pdfState['imageMetersPerPx'] ?? null);
    if ($metersPerPx === null || $metersPerPx <= 0) {
        $radius = fm_tutorial_number_or_null($pdfState['radiusMeters'] ?? null);
        $dims = is_array($pdfState['dims'] ?? null) ? $pdfState['dims'] : [];
        $width = fm_tutorial_number_or_null($dims['w'] ?? null);
        if ($radius !== null && $radius > 0 && $width !== null && $width > 0) {
            $metersPerPx = ($radius * 2.0) / $width;
        }
    }
    if ($metersPerPx === null || $metersPerPx <= 0) return null;

    $pitchAreas = [];
    $totalSqFt = 0.0;
    $facetCount = 0;
    foreach ($faces as $face) {
        if (!is_array($face)) continue;
        $points = is_array($face['points'] ?? null) ? $face['points'] : [];
        if (count($points) < 3) continue;
        $areaPx = fm_tutorial_polygon_area_px($points);
        if ($areaPx <= 2.0) continue;
        $facetCount++;
        $rise = fm_tutorial_face_pitch_rise($face, $metersPerPx);
        $pitchDeg = atan($rise / 12.0);
        $cos = cos($pitchDeg);
        if ($cos <= 0.000001) $cos = 1.0;
        $areaSqFt = (($areaPx * $metersPerPx * $metersPerPx) / $cos) * 10.7639;
        $pitchLabel = ((int)round($rise)) . '/12';
        $pitchAreas[$pitchLabel] = ($pitchAreas[$pitchLabel] ?? 0.0) + $areaSqFt;
        $totalSqFt += $areaSqFt;
    }
    if ($facetCount <= 0 || $totalSqFt <= 0) return null;
    ksort($pitchAreas);
    return [
        'facet_count' => $facetCount,
        'area_sq_ft' => $totalSqFt,
        'pitch_area_sq_ft_by_label' => $pitchAreas
    ];
}

function fm_tutorial_count_faces($metadata, $pdfState) {
    $manual = fm_tutorial_number_or_null($pdfState['manualTotalFacets'] ?? ($metadata['pdfConfig']['manualTotalFacets'] ?? null));
    if ($manual !== null && $manual > 0) return (int)round($manual);

    $facesData = $pdfState['facesData'] ?? null;
    if (is_array($facesData)) {
        $count = 0;
        foreach ($facesData as $face) {
            if (is_array($face) && is_array($face['points'] ?? null) && count($face['points']) >= 3) $count++;
        }
        if ($count > 0) return $count;
    }

    $geometry = is_array($metadata['geometry'] ?? null) ? $metadata['geometry'] : (is_array($pdfState['geometry'] ?? null) ? $pdfState['geometry'] : []);
    $count = 0;
    foreach (['resolvedFaces', 'manualFaces'] as $key) {
        if (!is_array($geometry[$key] ?? null)) continue;
        foreach ($geometry[$key] as $face) {
            if (is_array($face)) $count++;
        }
    }
    return $count;
}

function fm_tutorial_extract_score_metrics($metadata, $pdfState) {
    $metadata = is_array($metadata) ? $metadata : [];
    $pdfState = is_array($pdfState) ? $pdfState : [];
    $report = is_array($pdfState['report'] ?? null) ? $pdfState['report'] : [];
    $materials = is_array($report['materials'] ?? null) ? $report['materials'] : [];
    $facetCount = fm_tutorial_count_faces($metadata, $pdfState);

    $totalSquares = fm_tutorial_number_or_null($materials['totalSquares'] ?? null);
    if ($totalSquares === null) {
        $pitchSquares = fm_tutorial_metric_map($materials['squares'] ?? []);
        if ($pitchSquares) $totalSquares = array_sum($pitchSquares);
    }
    $areaSqFt = $totalSquares !== null ? $totalSquares * 100.0 : 0.0;
    $pitchAreas = fm_tutorial_pitch_areas_from_report($report);
    $lineLengths = fm_tutorial_line_lengths_from_report($report);

    $faceMetrics = fm_tutorial_recalculate_face_area_metrics($pdfState);
    if (is_array($faceMetrics)) {
        if ($facetCount <= 0 && (int)($faceMetrics['facet_count'] ?? 0) > 0) {
            $facetCount = (int)$faceMetrics['facet_count'];
        }
        if ($areaSqFt <= 0.001) {
            $areaSqFt = (float)$faceMetrics['area_sq_ft'];
        }
        if (!$pitchAreas) {
            $pitchAreas = $faceMetrics['pitch_area_sq_ft_by_label'];
        }
    }

    $geometryMetrics = fm_tutorial_recalculate_geometry_score_metrics($metadata, $pdfState);
    if (is_array($geometryMetrics)) {
        $geometryFacetCount = (int)($geometryMetrics['facet_count'] ?? 0);
        // The PDF snapshot is the submitted report and is authoritative. Raw
        // geometry is only a fallback because copied/resolved faces may not
        // retain the same point-object identities used by the editor.
        if ($facetCount <= 0 && $geometryFacetCount > 0) {
            $facetCount = $geometryFacetCount;
        }
        if ($areaSqFt <= 0.001 && ($geometryMetrics['area_sq_ft'] ?? 0) > 0.001) {
            $areaSqFt = (float)$geometryMetrics['area_sq_ft'];
        }
        if (!$pitchAreas && !empty($geometryMetrics['pitch_area_sq_ft_by_label']) && is_array($geometryMetrics['pitch_area_sq_ft_by_label'])) {
            $pitchAreas = $geometryMetrics['pitch_area_sq_ft_by_label'];
        }
        if (!$lineLengths && !empty($geometryMetrics['line_lengths_by_type']) && is_array($geometryMetrics['line_lengths_by_type'])) {
            $lineLengths = $geometryMetrics['line_lengths_by_type'];
        }
    }

    $hasQuad = fm_tutorial_truthy_asset($metadata['hasQuadCrop'] ?? null)
        || fm_tutorial_truthy_asset($pdfState['quadImage'] ?? null)
        || fm_tutorial_truthy_asset($pdfState['quadView'] ?? null)
        || fm_tutorial_truthy_asset($pdfState['quad_view'] ?? null);

    return [
        'quad_view_attached' => $hasQuad,
        'facet_count' => $facetCount,
        'area_sq_ft' => $areaSqFt,
        'line_lengths_by_type' => $lineLengths,
        'pitch_area_sq_ft_by_label' => $pitchAreas
    ];
}

function fm_tutorial_build_answer_key_from_bundle($sourceBundle, $sourceProjectId = '') {
    $metadata = is_array($sourceBundle['app_metadata'] ?? null) ? $sourceBundle['app_metadata'] : [];
    $pdfState = is_array($sourceBundle['pdf_state'] ?? null) ? $sourceBundle['pdf_state'] : [];
    return [
        'version' => FIRSTMEASURE_TUTORIAL_ANSWER_KEY_VERSION,
        'source_project_id' => fm_tutorial_sanitize_project_id($sourceProjectId),
        'generated_at' => gmdate('c'),
        'metrics' => fm_tutorial_extract_score_metrics($metadata, $pdfState)
    ];
}

function fm_tutorial_score_clamped($diffRatio, $points, $fullAt, $zeroAt) {
    $diffRatio = max(0.0, (float)$diffRatio);
    $points = max(0.0, (float)$points);
    if ($diffRatio <= $fullAt) return $points;
    if ($diffRatio >= $zeroAt) return 0.0;
    $span = max(0.000001, $zeroAt - $fullAt);
    return $points * (1.0 - (($diffRatio - $fullAt) / $span));
}

function fm_tutorial_relative_diff($submitted, $expected) {
    $submitted = (float)$submitted;
    $expected = (float)$expected;
    if (abs($expected) < 0.000001) return abs($submitted) < 0.000001 ? 0.0 : 1.0;
    return abs($submitted - $expected) / abs($expected);
}

function fm_tutorial_map_relative_diff($submitted, $expected) {
    $submitted = is_array($submitted) ? $submitted : [];
    $expected = is_array($expected) ? $expected : [];
    $keys = array_unique(array_merge(array_keys($submitted), array_keys($expected)));
    $absolute = 0.0;
    $expectedTotal = 0.0;
    foreach ($keys as $key) {
        $s = is_numeric($submitted[$key] ?? null) ? (float)$submitted[$key] : 0.0;
        $e = is_numeric($expected[$key] ?? null) ? (float)$expected[$key] : 0.0;
        $absolute += abs($s - $e);
        $expectedTotal += abs($e);
    }
    if ($expectedTotal < 0.000001) {
        $submittedTotal = 0.0;
        foreach ($submitted as $value) if (is_numeric($value)) $submittedTotal += abs((float)$value);
        return $submittedTotal < 0.000001 ? 0.0 : 1.0;
    }
    return $absolute / $expectedTotal;
}

function fm_tutorial_line_type_relative_diff($submitted, $expected) {
    $submitted = fm_tutorial_metric_map(is_array($submitted) ? $submitted : [], 'fm_tutorial_normalize_line_type');
    $expected = fm_tutorial_metric_map(is_array($expected) ? $expected : [], 'fm_tutorial_normalize_line_type');
    $expectedTotal = 0.0;
    foreach ($expected as $value) $expectedTotal += abs((float)$value);
    if ($expectedTotal < 0.000001) {
        $submittedTotal = 0.0;
        foreach ($submitted as $value) $submittedTotal += abs((float)$value);
        return $submittedTotal < 0.000001 ? 0.0 : 1.0;
    }

    $absolute = 0.0;
    foreach ($expected as $key => $expectedValue) {
        $absolute += abs(((float)($submitted[$key] ?? 0.0)) - ((float)$expectedValue));
    }

    foreach ($submitted as $key => $submittedValue) {
        if (array_key_exists($key, $expected)) continue;
        // Extra roof-category lines matter, but should not overwhelm the score as
        // much as missing expected length. Non-roof accessories are filtered out
        // before this point.
        $absolute += abs((float)$submittedValue) * 0.35;
    }
    return $absolute / $expectedTotal;
}

function fm_tutorial_pitch_distribution_relative_diff($submitted, $expected) {
    $submitted = fm_tutorial_metric_map(is_array($submitted) ? $submitted : [], 'fm_tutorial_normalize_pitch_label');
    $expected = fm_tutorial_metric_map(is_array($expected) ? $expected : [], 'fm_tutorial_normalize_pitch_label');
    $submittedTotal = 0.0;
    foreach ($submitted as $value) $submittedTotal += max(0.0, (float)$value);
    $expectedTotal = 0.0;
    foreach ($expected as $value) $expectedTotal += max(0.0, (float)$value);

    if ($expectedTotal < 0.000001) return $submittedTotal < 0.000001 ? 0.0 : 1.0;
    if ($submittedTotal < 0.000001) return 1.0;

    $rises = [];
    $submittedByRise = [];
    foreach ($submitted as $pitch => $value) {
        $rise = fm_tutorial_pitch_rise_from_label($pitch);
        if ($rise === null) continue;
        $key = (string)((int)round($rise));
        $submittedByRise[$key] = ($submittedByRise[$key] ?? 0.0) + max(0.0, (float)$value) / $submittedTotal;
        $rises[] = (int)round($rise);
    }
    $expectedByRise = [];
    foreach ($expected as $pitch => $value) {
        $rise = fm_tutorial_pitch_rise_from_label($pitch);
        if ($rise === null) continue;
        $key = (string)((int)round($rise));
        $expectedByRise[$key] = ($expectedByRise[$key] ?? 0.0) + max(0.0, (float)$value) / $expectedTotal;
        $rises[] = (int)round($rise);
    }
    if (!$rises || !$expectedByRise) return fm_tutorial_map_relative_diff($submitted, $expected);

    $minRise = min($rises);
    $maxRise = max($rises);
    $cumulative = 0.0;
    $emd = 0.0;
    for ($rise = $minRise; $rise <= $maxRise; $rise++) {
        $key = (string)$rise;
        $cumulative += ($submittedByRise[$key] ?? 0.0) - ($expectedByRise[$key] ?? 0.0);
        $emd += abs($cumulative);
    }

    // A one-pitch-bucket shift should be a partial miss, not a zero. Area has
    // its own category, so this category mostly grades pitch distribution.
    $distributionDiff = $emd / 4.0;
    $areaDiff = fm_tutorial_relative_diff($submittedTotal, $expectedTotal) * 0.25;
    return min(1.0, $distributionDiff + $areaDiff);
}

function fm_tutorial_score_category_from_diff($key, $label, $diff, $points, $fullAt, $zeroAt, $message = null) {
    $score = fm_tutorial_score_clamped($diff, $points, $fullAt, $zeroAt);
    $out = [
        'key' => $key,
        'label' => $label,
        'score' => round($score, 2),
        'max_score' => $points,
        'diff_percent' => round($diff * 100.0, 2),
        'status' => $score >= ($points - 0.001) ? 'correct' : ($score <= 0.001 ? 'missed' : 'partial')
    ];
    if ($message !== null) $out['message'] = $message;
    return $out;
}

function fm_tutorial_score_category($key, $label, $submitted, $expected, $points, $fullAt, $zeroAt) {
    $diff = is_array($expected) || is_array($submitted)
        ? fm_tutorial_map_relative_diff($submitted, $expected)
        : fm_tutorial_relative_diff($submitted, $expected);
    return fm_tutorial_score_category_from_diff($key, $label, $diff, $points, $fullAt, $zeroAt);
}

function fm_tutorial_score_line_types_category($submitted, $expected) {
    $diff = fm_tutorial_line_type_relative_diff($submitted, $expected);
    return fm_tutorial_score_category_from_diff(
        'line_types',
        'Line types',
        $diff,
        25,
        0.03,
        0.20,
        'Roof line categories are normalized before scoring; accessory lines are ignored.'
    );
}

function fm_tutorial_score_pitch_areas_category($submitted, $expected) {
    $diff = fm_tutorial_pitch_distribution_relative_diff($submitted, $expected);
    return fm_tutorial_score_category_from_diff(
        'pitch_areas',
        'Pitch areas',
        $diff,
        25,
        0.10,
        0.40,
        'Pitch scoring compares the area distribution by pitch bucket; total area is scored separately.'
    );
}

function fm_tutorial_calculate_project_score($courseId, $userEmail, $tutorialId, $manifest) {
    $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
    if (!$found) return null;

    $answerKeyFile = $found['dir'] . 'answer_key.json';
    $answerKey = fm_tutorial_read_json_file($answerKeyFile, null);
    $answerKeyVersion = (int)($answerKey['version'] ?? 0);
    $needsAnswerKeyRefresh = !is_array($answerKey)
        || !is_array($answerKey['metrics'] ?? null)
        || $answerKeyVersion < FIRSTMEASURE_TUTORIAL_ANSWER_KEY_VERSION;
    if ($needsAnswerKeyRefresh) {
        $sourceProjectId = fm_tutorial_sanitize_project_id($manifest['source_project_id'] ?? $manifest['original_master_id'] ?? '');
        $sourceBundle = $sourceProjectId && function_exists('fm_fetch_project_bundle') ? fm_fetch_project_bundle($sourceProjectId) : null;
        if (is_array($sourceBundle)) {
            $answerKey = fm_tutorial_build_answer_key_from_bundle($sourceBundle, $sourceProjectId);
            fm_tutorial_write_json_file($answerKeyFile, $answerKey);
        }
    }
    if (
        $needsAnswerKeyRefresh
        && (
            !is_array($answerKey)
            || !is_array($answerKey['metrics'] ?? null)
            || (int)($answerKey['version'] ?? 0) < FIRSTMEASURE_TUTORIAL_ANSWER_KEY_VERSION
        )
    ) {
        return ['score' => null, 'status' => 'calculating', 'error' => 'No current answer key is available yet.'];
    }
    if (!is_array($answerKey) || !is_array($answerKey['metrics'] ?? null)) {
        return ['score' => null, 'status' => 'calculating', 'error' => 'No answer key is available yet.'];
    }

    $metadata = fm_tutorial_read_json_file($found['dir'] . 'metadata.json', []);
    $pdfState = fm_tutorial_read_json_file($found['dir'] . 'pdf_state.json', []);
    $submitted = fm_tutorial_extract_score_metrics($metadata, $pdfState);
    $expected = $answerKey['metrics'];

    $categories = [];
    $categories['facet_count'] = fm_tutorial_score_category('facet_count', 'Facets', $submitted['facet_count'] ?? 0, $expected['facet_count'] ?? 0, 25, 0.0, 0.15);
    $categories['area'] = fm_tutorial_score_category('area', 'Area', $submitted['area_sq_ft'] ?? 0, $expected['area_sq_ft'] ?? 0, 25, 0.03, 0.20);
    $categories['line_types'] = fm_tutorial_score_line_types_category($submitted['line_lengths_by_type'] ?? [], $expected['line_lengths_by_type'] ?? []);
    $categories['pitch_areas'] = fm_tutorial_score_pitch_areas_category($submitted['pitch_area_sq_ft_by_label'] ?? [], $expected['pitch_area_sq_ft_by_label'] ?? []);

    $total = 0.0;
    foreach ($categories as $category) $total += (float)($category['score'] ?? 0);

    return [
        'score' => round(max(0, min(100, $total)), 2),
        'status' => 'scored',
        'max_score' => 100,
        'grading_version' => FIRSTMEASURE_TUTORIAL_GRADING_VERSION,
        'categories' => $categories,
        'answer_key_version' => $answerKey['version'] ?? 1,
        'answer_key_source_project_id' => $answerKey['source_project_id'] ?? null,
        'answer_key_generated_at' => $answerKey['generated_at'] ?? null,
        'expected_metrics' => $expected,
        'scored_at' => gmdate('c')
    ];
}

function fm_tutorial_score_metric_for_category($key) {
    $map = [
        'facet_count' => 'facet_count',
        'area' => 'area_sq_ft',
        'line_types' => 'line_lengths_by_type',
        'pitch_areas' => 'pitch_area_sq_ft_by_label'
    ];
    return $map[$key] ?? $key;
}

function fm_tutorial_score_category_thresholds($key) {
    $map = [
        'facet_count' => ['full_credit_at_diff_percent' => 0, 'zero_credit_at_diff_percent' => 15],
        'area' => ['full_credit_at_diff_percent' => 3, 'zero_credit_at_diff_percent' => 20],
        'line_types' => ['full_credit_at_diff_percent' => 3, 'zero_credit_at_diff_percent' => 20],
        'pitch_areas' => ['full_credit_at_diff_percent' => 10, 'zero_credit_at_diff_percent' => 40],
        'decision' => ['full_credit_at_diff_percent' => 0, 'zero_credit_at_diff_percent' => 100]
    ];
    return $map[$key] ?? ['full_credit_at_diff_percent' => null, 'zero_credit_at_diff_percent' => null];
}

function fm_tutorial_score_category_audit($key, $category, $submittedMetrics, $expectedMetrics) {
    $category = is_array($category) ? $category : [];
    $metricKey = fm_tutorial_score_metric_for_category($key);
    $thresholds = fm_tutorial_score_category_thresholds($key);
    return array_merge($category, [
        'metric_key' => $metricKey,
        'submitted_value' => is_array($submittedMetrics) ? ($submittedMetrics[$metricKey] ?? null) : null,
        'expected_value' => is_array($expectedMetrics) ? ($expectedMetrics[$metricKey] ?? null) : null,
        'full_credit_at_diff_percent' => $thresholds['full_credit_at_diff_percent'],
        'zero_credit_at_diff_percent' => $thresholds['zero_credit_at_diff_percent']
    ]);
}

function fm_tutorial_practice_grading_enabled($courseId, $manifest) {
    if (!is_array($manifest)) return true;
    if (($manifest['tutorial_kind'] ?? 'practice') !== 'practice' || !empty($manifest['test_attempt_id']) || !empty($manifest['draft_reject_attempt_id'])) {
        return true;
    }
    if (array_key_exists('tutorial_grading_enabled', $manifest)) {
        return $manifest['tutorial_grading_enabled'] !== false;
    }

    $curriculum = fm_tutorial_read_curriculum($courseId);
    [, $chapter] = fm_tutorial_find_chapter_for_manifest($curriculum, $manifest);
    if (!is_array($chapter)) return true;

    $manifestItemId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($manifest['curriculum_project_id'] ?? $manifest['practice_project_id'] ?? ''));
    $manifestSourceId = fm_tutorial_sanitize_project_id($manifest['source_project_id'] ?? $manifest['original_master_id'] ?? '');
    foreach (fm_tutorial_chapter_project_list($chapter, false) as $project) {
        $projectItemId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($project['curriculum_project_id'] ?? $project['practice_project_id'] ?? ''));
        $projectSourceId = fm_tutorial_source_id_from_project($project);
        $matches = $manifestItemId !== ''
            ? $projectItemId === $manifestItemId
            : ($projectItemId === '' && $projectSourceId === $manifestSourceId);
        if (!$matches) continue;
        return !array_key_exists('grading_enabled', $project) || $project['grading_enabled'] !== false;
    }
    return true;
}

function fm_tutorial_ungraded_score_result() {
    return [
        'score' => null,
        'score_status' => 'not_graded',
        'scored_at' => null,
        'details' => [
            'grading_enabled' => false,
            'message' => 'Grading is disabled for this practice project.'
        ]
    ];
}

function fm_tutorial_project_grading_audit($courseId, $userEmail, $tutorialId) {
    $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
    if (!$found) return ['success' => false, 'error' => 'Tutorial project not found.'];

    $manifest = is_array($found['manifest'] ?? null) ? $found['manifest'] : [];
    $metadata = fm_tutorial_read_json_file($found['dir'] . 'metadata.json', []);
    $pdfState = fm_tutorial_read_json_file($found['dir'] . 'pdf_state.json', []);
    $submitted = fm_tutorial_extract_score_metrics($metadata, $pdfState);
    $gradingEnabled = fm_tutorial_practice_grading_enabled($found['course_id'], $manifest);
    $projectStatus = strtolower((string)($manifest['status'] ?? ''));
    $projectSubmitted = !empty($manifest['completed_at'])
        || !empty($manifest['locked_for_student'])
        || strpos($projectStatus, 'completed') !== false
        || strpos($projectStatus, 'locked') !== false;
    if (!$projectSubmitted) {
        $scoreResult = [
            'score' => null,
            'score_status' => 'in_progress',
            'scored_at' => null,
            'details' => ['message' => 'This exam project has not been submitted yet.']
        ];
    } else {
        $scoreResult = $gradingEnabled
            ? fm_tutorial_score_project_instance($found['course_id'], $userEmail, $tutorialId, $manifest)
            : fm_tutorial_ungraded_score_result();
    }
    $details = is_array($scoreResult['details'] ?? null) ? $scoreResult['details'] : [];

    if (($scoreResult['score_status'] ?? '') === 'scored') {
        $manifest['tutorial_score_status'] = $scoreResult['score_status'];
        $manifest['tutorial_score'] = $scoreResult['score'];
        $manifest['tutorial_score_details'] = $details;
        $manifest['tutorial_scored_at'] = $scoreResult['scored_at'];
        $manifest['tutorial_grading_version'] = FIRSTMEASURE_TUTORIAL_GRADING_VERSION;
        $manifest['updated_at'] = gmdate('c');
        fm_tutorial_write_json_file($found['dir'] . 'manifest.json', $manifest);
    }

    $answerKey = fm_tutorial_read_json_file($found['dir'] . 'answer_key.json', []);
    $expected = is_array($answerKey['metrics'] ?? null)
        ? $answerKey['metrics']
        : (is_array($details['expected_metrics'] ?? null) ? $details['expected_metrics'] : []);
    $answerKeyVersion = (int)($answerKey['version'] ?? 0);
    if ($answerKeyVersion <= 0 && is_numeric($details['answer_key_version'] ?? null)) {
        $answerKeyVersion = (int)$details['answer_key_version'];
    }
    $categories = [];
    foreach (($details['categories'] ?? []) as $key => $category) {
        if (!is_array($category)) continue;
        $categories[$key] = fm_tutorial_score_category_audit($key, $category, $submitted, $expected);
    }

    $storedDetails = is_array($found['manifest']['tutorial_score_details'] ?? null) ? $found['manifest']['tutorial_score_details'] : [];
    $sourceProjectId = fm_tutorial_sanitize_project_id($manifest['source_project_id'] ?? ($manifest['original_master_id'] ?? ''));
    $projectAddress = trim((string)(
        $manifest['source_address']
        ?? $manifest['address']
        ?? $manifest['project_address']
        ?? ''
    ));
    $studentProjectUrl = 'editor.php?tutorial=1&folder=' . rawurlencode($tutorialId)
        . '&course_id=' . rawurlencode((string)$found['course_id'])
        . '&student_email=' . rawurlencode((string)$userEmail);
    $sourceProjectUrl = $sourceProjectId !== '' ? ('editor.php?folder=' . rawurlencode($sourceProjectId)) : '';
    $mapSearchUrl = $projectAddress !== '' ? ('https://www.google.com/maps/search/?api=1&query=' . rawurlencode($projectAddress)) : '';
    $mapEmbedUrl = $projectAddress !== '' ? ('https://maps.google.com/maps?q=' . rawurlencode($projectAddress) . '&output=embed') : '';

    return [
        'success' => true,
        'student_email' => $userEmail,
        'course_id' => $found['course_id'],
        'tutorial_id' => $tutorialId,
        'source_project_id' => $sourceProjectId,
        'project' => [
            'id' => $tutorialId,
            'status' => $manifest['status'] ?? '',
            'tutorial_kind' => $manifest['tutorial_kind'] ?? 'practice',
            'address' => $projectAddress,
            'source_address' => $projectAddress,
            'chapter_id' => $manifest['chapter_id'] ?? null,
            'test_attempt_id' => $manifest['test_attempt_id'] ?? null,
            'test_title' => $manifest['test_title'] ?? null,
            'sequence_index' => $manifest['test_sequence_index'] ?? ($manifest['draft_reject_sequence_index'] ?? null),
            'sequence_total' => $manifest['test_sequence_total'] ?? ($manifest['draft_reject_sequence_total'] ?? null),
            'created_at' => $manifest['created_at'] ?? null,
            'updated_at' => $manifest['updated_at'] ?? null,
            'completed_at' => $manifest['completed_at'] ?? null,
            'locked_for_student' => !empty($manifest['locked_for_student'])
        ],
        'stored_score' => [
            'score' => $projectSubmitted && is_numeric($found['manifest']['tutorial_score'] ?? null) ? (float)$found['manifest']['tutorial_score'] : null,
            'score_status' => $projectSubmitted ? ($found['manifest']['tutorial_score_status'] ?? 'calculating') : 'in_progress',
            'grading_version' => $found['manifest']['tutorial_grading_version'] ?? ($storedDetails['grading_version'] ?? null),
            'scored_at' => $found['manifest']['tutorial_scored_at'] ?? null
        ],
        'current_score' => [
            'score' => is_numeric($scoreResult['score'] ?? null) ? (float)$scoreResult['score'] : null,
            'score_status' => $scoreResult['score_status'] ?? 'calculating',
            'grading_version' => $details['grading_version'] ?? FIRSTMEASURE_TUTORIAL_GRADING_VERSION,
            'scored_at' => $scoreResult['scored_at'] ?? null,
            'max_score' => $details['max_score'] ?? 100
        ],
        'answer_key' => [
            'version' => $answerKeyVersion > 0 ? $answerKeyVersion : null,
            'source_project_id' => $answerKey['source_project_id'] ?? ($details['answer_key_source_project_id'] ?? null),
            'generated_at' => $answerKey['generated_at'] ?? ($details['answer_key_generated_at'] ?? null),
            'has_metrics' => !empty($expected)
        ],
        'links' => [
            'student_project_editor_url' => $studentProjectUrl,
            'source_project_editor_url' => $sourceProjectUrl,
            'map_search_url' => $mapSearchUrl,
            'map_embed_url' => $mapEmbedUrl
        ],
        'submitted_metrics' => $submitted,
        'expected_metrics' => $expected,
        'categories' => $categories,
        'raw_details' => $details
    ];
}

function fm_tutorial_create_project_instance($sourceProjectId, $courseId, $userEmail, $chapterId = null, $options = []) {
    $sourceProjectId = fm_tutorial_sanitize_project_id($sourceProjectId);
    if ($sourceProjectId === '' || fm_tutorial_is_tutorial_project_id($sourceProjectId)) {
        return ['success' => false, 'error' => 'A real source project ID is required.'];
    }

    $sourceBundle = function_exists('fm_fetch_project_bundle') ? fm_fetch_project_bundle($sourceProjectId) : null;
    if (!is_array($sourceBundle) || !is_array($sourceBundle['manifest'] ?? null)) {
        return ['success' => false, 'error' => 'Source project not found.'];
    }

    $tutorialId = fm_tutorial_new_id($courseId, $userEmail);
    $dir = fm_tutorial_project_dir($courseId, $userEmail, $tutorialId);
    if (!$dir) return ['success' => false, 'error' => 'Could not create tutorial project ID.'];
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    @mkdir($dir . 'artifacts/', 0775, true);

    $sourceManifest = $sourceBundle['manifest'];
    $manifest = [
        'id' => $tutorialId,
        'status' => 'tutorial_in_progress',
        'is_tutorial_instance' => true,
        'tutorial_mode' => true,
        'tutorial_course_id' => $courseId,
        'source_project_id' => $sourceProjectId,
        'original_master_id' => $sourceProjectId,
        'owner_email' => $userEmail,
        'chapter_id' => $chapterId,
        'source_address' => $sourceManifest['address'] ?? '',
        'created_at' => gmdate('c'),
        'updated_at' => gmdate('c'),
        'tutorial_progress' => []
    ];
    if (is_array($options)) {
        foreach ([
            'tutorial_kind',
            'test_attempt_id',
            'test_id',
            'test_title',
            'test_sequence_index',
            'test_sequence_total',
            'test_started_at',
            'test_due_at',
            'draft_reject_attempt_id',
            'draft_reject_round_id',
            'draft_reject_title',
            'draft_reject_mode',
            'draft_reject_expected_decision',
            'draft_reject_sequence_index',
            'draft_reject_sequence_total',
            'draft_reject_started_at',
            'locked_for_student',
            'curriculum_project_id',
            'practice_project_name'
        ] as $key) {
            if (array_key_exists($key, $options)) $manifest[$key] = $options[$key];
        }
    }
    $answerKey = fm_tutorial_build_answer_key_from_bundle($sourceBundle, $sourceProjectId);
    fm_tutorial_write_json_file($dir . 'manifest.json', $manifest);
    fm_tutorial_write_json_file($dir . 'answer_key.json', $answerKey);
    fm_tutorial_write_json_file($dir . 'metadata.json', [
        'geometry' => null,
        'createdFromSourceProjectId' => $sourceProjectId,
        'tutorialProjectId' => $tutorialId
    ]);

    return [
        'success' => true,
        'folder' => $tutorialId,
        'tutorial_id' => $tutorialId,
        'source_project_id' => $sourceProjectId,
        'course_id' => $courseId,
        'editor_url' => 'editor.php?tutorial=1&folder=' . rawurlencode($tutorialId) . '&course_id=' . rawurlencode($courseId)
    ];
}

function fm_tutorial_find_project($tutorialId, $userEmail, $courseId = null) {
    $tutorialId = fm_tutorial_sanitize_project_id($tutorialId);
    if (!fm_tutorial_is_tutorial_project_id($tutorialId)) return null;
    $courses = [];
    if ($courseId !== null && $courseId !== '') $courses[] = (string)$courseId;
    $courses[] = 'default';

    $safeUser = fm_tutorial_safe_user($userEmail);
    $userRoot = storageDir('tutorials/users/' . $safeUser . '/courses');
    if (is_dir($userRoot)) {
        foreach (scandir($userRoot) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') continue;
            if (is_dir($userRoot . '/' . $entry)) $courses[] = $entry;
        }
    }
    $courses = array_values(array_unique($courses));

    foreach ($courses as $cid) {
        $file = fm_tutorial_project_manifest_file($cid, $userEmail, $tutorialId);
        if ($file && is_file($file)) {
            $manifest = fm_tutorial_read_json_file($file, []);
            if (is_array($manifest) && ($manifest['id'] ?? '') === $tutorialId) {
                return ['course_id' => $cid, 'manifest' => $manifest, 'dir' => dirname($file) . '/'];
            }
        }
    }
    return null;
}

function fm_tutorial_merge_editor_metadata($sourceMeta, $userMeta) {
    $sourceMeta = is_array($sourceMeta) ? $sourceMeta : [];
    $userMeta = is_array($userMeta) ? $userMeta : [];
    $safeKeys = [
        'imageWidth',
        'imageHeight',
        'viewConfigs',
        'currentViewId',
        'viewRotation',
        'layer_config',
        'visual_adjustments',
        'displayCrop',
        'cropRegion',
        'editorCropPadding',
        'imageSettings'
    ];
    $merged = [];
    foreach ($safeKeys as $key) {
        if (array_key_exists($key, $sourceMeta)) $merged[$key] = $sourceMeta[$key];
    }
    foreach ($userMeta as $key => $value) {
        $merged[$key] = $value;
    }
    if (!array_key_exists('geometry', $merged)) $merged['geometry'] = null;
    return $merged;
}

function fm_tutorial_fetch_editor_bundle($tutorialId, $userEmail, $courseId = null, $allowLocked = false) {
    $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
    if (!$found) return null;

    $manifest = $found['manifest'];
    if (!empty($manifest['locked_for_student']) && !$allowLocked) return null;
    $cid = $found['course_id'];
    $sourceProjectId = fm_tutorial_sanitize_project_id($manifest['source_project_id'] ?? $manifest['original_master_id'] ?? '');
    if ($sourceProjectId === '') return null;

    $sourceBundle = function_exists('fm_fetch_project_bundle') ? fm_fetch_project_bundle($sourceProjectId) : null;
    if (!is_array($sourceBundle) || !is_array($sourceBundle['manifest'] ?? null)) return null;

    $userFiles = fm_tutorial_list_artifacts($cid, $userEmail, $tutorialId);
    $assets = is_array($sourceBundle['assets'] ?? null) ? $sourceBundle['assets'] : [];
    foreach ($userFiles as $file) {
        $base = strtolower(pathinfo($file['name'], PATHINFO_FILENAME));
        $assets[$base] = $file['url'];
    }

    $editorManifest = fm_tutorial_source_manifest_subset($sourceBundle['manifest'], $manifest);
    $userMetadata = fm_tutorial_read_json_file($found['dir'] . 'metadata.json', []);
    $editorMetadata = fm_tutorial_merge_editor_metadata($sourceBundle['app_metadata'] ?? [], $userMetadata);
    if (!empty($manifest['test_attempt_id'])) {
        $progress = fm_tutorial_read_progress($cid, $userEmail);
        $attempt = is_array($progress['test_attempts'][$manifest['test_attempt_id']] ?? null)
            ? $progress['test_attempts'][$manifest['test_attempt_id']]
            : [];
        $editorManifest['test_attempt_id'] = $manifest['test_attempt_id'];
        $editorManifest['test_id'] = $manifest['test_id'] ?? ($attempt['test_id'] ?? null);
        $editorManifest['test_title'] = $manifest['test_title'] ?? ($attempt['test_title'] ?? null);
        $editorManifest['test_started_at'] = $attempt['started_at'] ?? ($manifest['test_started_at'] ?? null);
        $editorManifest['test_due_at'] = $attempt['due_at'] ?? ($manifest['test_due_at'] ?? null);
        $editorManifest['test_completed_count'] = (int)($attempt['completed_count'] ?? 0);
        $editorManifest['test_project_count'] = (int)($attempt['sample_count'] ?? $manifest['test_sequence_total'] ?? 0);
        $editorManifest['test_sequence_index'] = $manifest['test_sequence_index'] ?? null;
        $editorManifest['test_sequence_total'] = $manifest['test_sequence_total'] ?? null;
        $editorManifest['tutorial_kind'] = 'test';
    }

    return [
        'folder' => $tutorialId,
        'manifest' => $editorManifest,
        'organization' => $sourceBundle['organization'] ?? null,
        'app_metadata' => $editorMetadata,
        'pdf_state' => fm_tutorial_read_json_file($found['dir'] . 'pdf_state.json', null),
        'pdf_state_asset' => fm_tutorial_editor_action_url('tutorial_project_pdf_state', [
            'tutorial_id' => $tutorialId,
            'course_id' => $cid
        ]),
        'assets' => $assets,
        'insights' => $sourceBundle['insights'] ?? null,
        'files' => array_merge(is_array($sourceBundle['files'] ?? null) ? $sourceBundle['files'] : [], $userFiles),
        'source_project_id' => $sourceProjectId,
        'course_id' => $cid
    ];
}

function fm_tutorial_save_editor_payload($tutorialId, $userEmail, $metadata, $pdfState = null, $courseId = null) {
    $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
    if (!$found) return ['success' => false, 'error' => 'Tutorial project not found.'];
    if (!empty($found['manifest']['locked_for_student'])) {
        return ['success' => false, 'error' => 'This test project is locked.'];
    }
    if ($metadata !== null) {
        $metadataFile = $found['dir'] . 'metadata.json';
        $existingMetadata = fm_tutorial_read_json_file($metadataFile, []);
        $nextMetadata = array_merge(is_array($existingMetadata) ? $existingMetadata : [], is_array($metadata) ? $metadata : []);
        if (!fm_tutorial_write_json_file($metadataFile, $nextMetadata)) {
            return ['success' => false, 'error' => 'Tutorial geometry could not be written to storage.'];
        }
        $savedMetadata = fm_tutorial_read_json_file($metadataFile, null);
        if (!is_array($savedMetadata)) {
            return ['success' => false, 'error' => 'Tutorial geometry could not be read back after saving.'];
        }
        if (array_key_exists('geometry', $nextMetadata)) {
            $expectedGeometry = json_encode($nextMetadata['geometry'], JSON_UNESCAPED_SLASHES);
            $savedGeometry = json_encode($savedMetadata['geometry'] ?? null, JSON_UNESCAPED_SLASHES);
            if ($expectedGeometry === false || $savedGeometry === false || !hash_equals($expectedGeometry, $savedGeometry)) {
                return ['success' => false, 'error' => 'Tutorial geometry verification failed after saving.'];
            }
        }
        $metadata = $nextMetadata;
    }
    if ($pdfState !== null) {
        if (!fm_tutorial_write_json_file($found['dir'] . 'pdf_state.json', $pdfState)) {
            return ['success' => false, 'error' => 'Tutorial report state could not be written to storage.'];
        }
    }
    $manifest = $found['manifest'];
    $manifest['updated_at'] = gmdate('c');
    if (is_array($metadata)) {
        $radius = $metadata['layer_config']['__radius']['scale'] ?? null;
        if (is_numeric($radius) && (float)$radius > 0) $manifest['radius_meters'] = (float)$radius;
    }
    if (!fm_tutorial_write_json_file($found['dir'] . 'manifest.json', $manifest)) {
        return ['success' => false, 'error' => 'Tutorial project manifest could not be updated.'];
    }
    $geometry = is_array($metadata['geometry'] ?? null) ? $metadata['geometry'] : [];
    return [
        'success' => true,
        'folder' => $tutorialId,
        'course_id' => $found['course_id'],
        'saved_geometry_points' => is_array($geometry['points'] ?? null) ? count($geometry['points']) : 0,
        'saved_geometry_connections' => is_array($geometry['connections'] ?? null) ? count($geometry['connections']) : 0
    ];
}

function fm_tutorial_parse_request_body() {
    $contentType = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''));
    if (strpos($contentType, 'application/json') !== false) {
        $raw = (string)@file_get_contents('php://input');
        $json = json_decode($raw, true);
        return is_array($json) ? $json : [];
    }
    return $_POST;
}

function fm_tutorial_handle_save_request($tutorialId, $userEmail, $courseId = null) {
    $metadata = null;
    $pdfState = null;

    if (!empty($_FILES)) {
        foreach ($_FILES as $field => $file) {
            if (!is_array($file) || (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK)) continue;
            if ($field === 'pdf_state') {
                $raw = (string)@file_get_contents((string)$file['tmp_name']);
                $parsed = json_decode($raw, true);
                $pdfState = $parsed;
                continue;
            }
            fm_tutorial_store_uploaded_file($tutorialId, $userEmail, $file, $courseId);
        }
    }

    $body = fm_tutorial_parse_request_body();
    if (array_key_exists('metadata', $body)) {
        $metadata = is_string($body['metadata']) ? json_decode($body['metadata'], true) : $body['metadata'];
        if (!is_array($metadata)) $metadata = [];
    }
    if (array_key_exists('pdf_state', $body)) {
        $pdfState = is_string($body['pdf_state']) ? json_decode($body['pdf_state'], true) : $body['pdf_state'];
    }

    return fm_tutorial_save_editor_payload($tutorialId, $userEmail, $metadata, $pdfState, $courseId);
}

function fm_tutorial_store_uploaded_file($tutorialId, $userEmail, $file, $courseId = null, $nameOverride = null) {
    $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
    if (!$found) return ['success' => false, 'error' => 'Tutorial project not found.'];
    if (!is_array($file) || (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK)) {
        return ['success' => false, 'error' => 'Upload failed.'];
    }
    $name = fm_tutorial_sanitize_file_name($nameOverride ?: ($file['name'] ?? 'file.bin'));
    $dir = fm_tutorial_project_artifacts_dir($found['course_id'], $userEmail, $tutorialId);
    if (!$dir) return ['success' => false, 'error' => 'Invalid tutorial project.'];
    $dest = $dir . $name;
    if (!@move_uploaded_file((string)$file['tmp_name'], $dest)) {
        if (!@rename((string)$file['tmp_name'], $dest)) {
            return ['success' => false, 'error' => 'Could not save uploaded file.'];
        }
    }
    return [
        'success' => true,
        'artifact' => [
            'name' => $name,
            'url' => fm_tutorial_artifact_url($tutorialId, $name, $found['course_id'])
        ]
    ];
}

function fm_tutorial_store_text_artifact($tutorialId, $userEmail, $fileName, $content, $courseId = null) {
    $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
    if (!$found) return ['success' => false, 'error' => 'Tutorial project not found.'];
    $name = fm_tutorial_sanitize_file_name($fileName, 'file.txt');
    $dir = fm_tutorial_project_artifacts_dir($found['course_id'], $userEmail, $tutorialId);
    if (!$dir) return ['success' => false, 'error' => 'Invalid tutorial project.'];
    @file_put_contents($dir . $name, (string)$content);
    return [
        'success' => true,
        'artifact' => [
            'name' => $name,
            'url' => fm_tutorial_artifact_url($tutorialId, $name, $found['course_id'])
        ]
    ];
}

function fm_tutorial_mark_project_complete($tutorialId, $userEmail, $courseId = null, $status = 'completed') {
    $found = fm_tutorial_find_project($tutorialId, $userEmail, $courseId);
    if (!$found) return ['success' => false, 'error' => 'Tutorial project not found.'];
    $manifest = $found['manifest'];
    $manifest['status'] = 'tutorial_' . preg_replace('/[^a-z0-9_\-]/', '', strtolower((string)$status));
    if (($manifest['tutorial_kind'] ?? 'practice') === 'test' || !empty($manifest['test_attempt_id'])) {
        $manifest['locked_for_student'] = true;
    }
    $manifest['completed_at'] = gmdate('c');
    $manifest['updated_at'] = gmdate('c');
    $gradingEnabled = fm_tutorial_practice_grading_enabled($found['course_id'], $manifest);
    $manifest['tutorial_grading_enabled'] = $gradingEnabled;
    $scoreResult = $gradingEnabled
        ? fm_tutorial_score_project_instance($found['course_id'], $userEmail, $tutorialId, $manifest)
        : fm_tutorial_ungraded_score_result();
    $manifest['tutorial_score_status'] = $scoreResult['score_status'];
    $manifest['tutorial_score'] = $scoreResult['score'];
    $manifest['tutorial_score_details'] = $scoreResult['details'];
    $manifest['tutorial_scored_at'] = $scoreResult['scored_at'];
    $manifest['tutorial_grading_version'] = $gradingEnabled ? FIRSTMEASURE_TUTORIAL_GRADING_VERSION : null;
    fm_tutorial_write_json_file($found['dir'] . 'manifest.json', $manifest);

    $progress = fm_tutorial_read_progress($found['course_id'], $userEmail);
    $exists = false;
    foreach ($progress['completed_projects'] as $entry) {
        if (is_string($entry) && $entry === $tutorialId) $exists = true;
        if (is_array($entry) && (($entry['tutorial_id'] ?? $entry['id'] ?? '') === $tutorialId)) $exists = true;
    }
    if (!$exists) {
        $progress['completed_projects'][] = [
            'tutorial_id' => $tutorialId,
            'source_project_id' => $manifest['source_project_id'] ?? '',
            'curriculum_project_id' => $manifest['curriculum_project_id'] ?? null,
            'chapter_id' => $manifest['chapter_id'] ?? null,
            'test_attempt_id' => $manifest['test_attempt_id'] ?? null,
            'date' => gmdate('c')
        ];
    }

    $completion = fm_tutorial_build_completion_context($tutorialId, $userEmail, $found['course_id'], $manifest, $progress);
    fm_tutorial_write_progress($found['course_id'], $userEmail, $progress);

    $response = [
        'success' => true,
        'manifest' => $manifest,
        'course_id' => $found['course_id'],
        'score' => $manifest['tutorial_score'] ?? null,
        'score_status' => $manifest['tutorial_score_status'] ?? 'calculating',
        'grading_enabled' => $gradingEnabled,
        'score_details' => $manifest['tutorial_score_details'] ?? null,
        'completion' => $completion
    ];
    $isHiddenExamGrade = (($manifest['tutorial_kind'] ?? '') === 'test' || !empty($manifest['test_attempt_id']))
        || (($manifest['tutorial_kind'] ?? '') === 'draft_reject' && ($manifest['draft_reject_mode'] ?? '') === 'test');
    if ($isHiddenExamGrade) {
        $response['manifest']['tutorial_score'] = null;
        $response['manifest']['tutorial_score_details'] = null;
        $response['manifest']['tutorial_score_status'] = 'submitted';
        $response['score'] = null;
        $response['score_status'] = 'submitted';
        $response['score_details'] = null;
        $response['grade_hidden'] = true;
        if (is_array($response['completion'] ?? null)) {
            unset($response['completion']['final_score'], $response['completion']['passing_score_percent'], $response['completion']['passed']);
            $response['completion']['grade_hidden'] = true;
        }
    }
    return $response;
}

function fm_tutorial_find_chapter_for_manifest($curriculum, $manifest) {
    $chapters = is_array($curriculum['chapters'] ?? null) ? $curriculum['chapters'] : [];
    $chapterId = $manifest['chapter_id'] ?? null;
    if ($chapterId !== null && $chapterId !== '') {
        $idx = max(0, ((int)$chapterId) - 1);
        if (isset($chapters[$idx])) return [$idx, $chapters[$idx]];
    }

    $sourceId = fm_tutorial_sanitize_project_id($manifest['source_project_id'] ?? $manifest['original_master_id'] ?? '');
    $manifestItemId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($manifest['curriculum_project_id'] ?? $manifest['practice_project_id'] ?? ''));
    foreach ($chapters as $idx => $chapter) {
        foreach (fm_tutorial_chapter_project_list($chapter, false) as $project) {
            if ($manifestItemId !== '' && (string)($project['curriculum_project_id'] ?? '') === $manifestItemId) return [$idx, $chapter];
            if ($manifestItemId !== '') continue;
            if (($project['source_project_id'] ?? '') === $sourceId) return [$idx, $chapter];
        }
        foreach (fm_tutorial_chapter_project_list($chapter, true) as $project) {
            if (($project['source_project_id'] ?? '') === $sourceId) return [$idx, $chapter];
        }
    }
    return [null, null];
}

function fm_tutorial_user_completed_practice_keys($projects) {
    $completed = [];
    foreach ($projects as $project) {
        if (!is_array($project)) continue;
        $status = strtolower((string)($project['status'] ?? ''));
        if (strpos($status, 'completed') === false && strpos($status, 'locked') === false) continue;
        $itemId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($project['curriculum_project_id'] ?? $project['practice_project_id'] ?? ''));
        if ($itemId !== '') {
            $completed['item:' . $itemId] = true;
            continue;
        }
        $sourceId = fm_tutorial_sanitize_project_id($project['source_project_id'] ?? $project['original_master_id'] ?? '');
        if ($sourceId !== '') $completed['source:' . $sourceId] = true;
    }
    return $completed;
}

function fm_tutorial_find_existing_practice_instance($courseId, $userEmail, $sourceProjectId, $chapterId = null, $curriculumProjectId = '') {
    $sourceProjectId = fm_tutorial_sanitize_project_id($sourceProjectId);
    $curriculumProjectId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)$curriculumProjectId);
    foreach (fm_tutorial_list_user_projects($userEmail, $courseId) as $project) {
        if (!is_array($project)) continue;
        if (($project['tutorial_kind'] ?? 'practice') === 'test') continue;
        $source = fm_tutorial_sanitize_project_id($project['source_project_id'] ?? $project['original_master_id'] ?? '');
        if ($source !== $sourceProjectId) continue;
        $projectItemId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($project['curriculum_project_id'] ?? $project['practice_project_id'] ?? ''));
        if ($curriculumProjectId !== '' && $projectItemId !== $curriculumProjectId) continue;
        if ($curriculumProjectId === '' && $projectItemId !== '') continue;
        if ($chapterId !== null && $chapterId !== '' && (string)($project['chapter_id'] ?? '') !== (string)$chapterId) continue;
        if (!empty($project['locked_for_student'])) continue;
        return $project;
    }
    return null;
}

function fm_tutorial_build_practice_completion_context($tutorialId, $userEmail, $courseId, $manifest, &$progress) {
    $curriculum = fm_tutorial_read_curriculum($courseId);
    [$chapterIdx, $chapter] = fm_tutorial_find_chapter_for_manifest($curriculum, $manifest);
    if (!is_array($chapter)) {
        return [
            'kind' => 'practice',
            'completed' => 1,
            'total' => 1,
            'label' => '1 of 1 completed',
            'next_project' => null,
            'course_complete' => false
        ];
    }

    $chapterId = $chapterIdx + 1;
    $projects = fm_tutorial_chapter_project_list($chapter, false);
    $total = count($projects);
    if ($total <= 0) $total = 1;

    $userProjects = fm_tutorial_list_user_projects($userEmail, $courseId);
    $completedKeys = fm_tutorial_user_completed_practice_keys($userProjects);
    $currentSource = fm_tutorial_sanitize_project_id($manifest['source_project_id'] ?? $manifest['original_master_id'] ?? '');
    $currentItemId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($manifest['curriculum_project_id'] ?? $manifest['practice_project_id'] ?? ''));
    $currentKey = $currentItemId !== '' ? ('item:' . $currentItemId) : ($currentSource !== '' ? ('source:' . $currentSource) : '');
    if ($currentKey !== '') $completedKeys[$currentKey] = true;

    $completed = 0;
    $nextProjectEntry = null;
    $currentIndex = -1;
    foreach ($projects as $idx => $project) {
        $sourceId = $project['source_project_id'] ?? '';
        $projectKey = fm_tutorial_project_entry_key($project);
        if ($sourceId === '') continue;
        if ($projectKey !== '' && $projectKey === $currentKey) $currentIndex = $idx;
        if ($projectKey !== '' && !empty($completedKeys[$projectKey])) {
            $completed++;
        }
    }

    for ($idx = max(0, $currentIndex + 1); $idx < count($projects); $idx++) {
        $projectKey = fm_tutorial_project_entry_key($projects[$idx]);
        if ($projectKey !== '' && empty($completedKeys[$projectKey])) {
            $nextProjectEntry = $projects[$idx];
            break;
        }
    }
    if ($nextProjectEntry === null) {
        foreach ($projects as $project) {
            $projectKey = fm_tutorial_project_entry_key($project);
            if ($projectKey !== '' && empty($completedKeys[$projectKey])) {
                $nextProjectEntry = $project;
                break;
            }
        }
    }

    $nextProject = null;
    if (is_array($nextProjectEntry)) {
        $nextSource = $nextProjectEntry['source_project_id'] ?? '';
        $nextItemId = $nextProjectEntry['curriculum_project_id'] ?? '';
        $existing = fm_tutorial_find_existing_practice_instance($courseId, $userEmail, $nextSource, $chapterId, $nextItemId);
        if (is_array($existing)) {
            $nextProject = [
                'source_project_id' => $nextSource,
                'curriculum_project_id' => $nextItemId,
                'tutorial_id' => $existing['id'] ?? '',
                'editor_url' => 'editor.php?tutorial=1&folder=' . rawurlencode((string)($existing['id'] ?? '')) . '&course_id=' . rawurlencode($courseId)
            ];
        } else {
            $created = fm_tutorial_create_project_instance($nextSource, $courseId, $userEmail, $chapterId, [
                'curriculum_project_id' => $nextItemId,
                'practice_project_name' => $nextProjectEntry['name'] ?? ''
            ]);
            if (!empty($created['success'])) $nextProject = $created;
        }
    }

    if ($completed >= $total && fm_tutorial_required_tests_passed($chapter, $progress, $chapterId) && fm_tutorial_required_draft_reject_rounds_passed($chapter, $progress, $chapterId) && $chapterId >= (int)($progress['current_chapter'] ?? 1)) {
        $progress['current_chapter'] = $chapterId + 1;
    }

    return [
        'kind' => 'practice',
        'chapter_id' => $chapterId,
        'chapter_title' => $chapter['title'] ?? '',
        'completed' => min($completed, $total),
        'total' => $total,
        'label' => min($completed, $total) . ' of ' . $total . ' completed',
        'next_project' => $nextProject,
        'course_complete' => $nextProject === null
    ];
}

function fm_tutorial_lock_test_attempt_projects($courseId, $userEmail, $attempt) {
    $ids = is_array($attempt['tutorial_project_ids'] ?? null) ? $attempt['tutorial_project_ids'] : [];
    foreach ($ids as $id) {
        $found = fm_tutorial_find_project($id, $userEmail, $courseId);
        if (!$found) continue;
        $manifest = $found['manifest'];
        $manifest['locked_for_student'] = true;
        $manifest['status'] = ($manifest['status'] ?? '') === 'tutorial_completed' ? 'tutorial_test_locked' : ($manifest['status'] ?? 'tutorial_test_locked');
        $manifest['updated_at'] = gmdate('c');
        fm_tutorial_write_json_file($found['dir'] . 'manifest.json', $manifest);
    }
}

function fm_tutorial_score_project_instance($courseId, $userEmail, $tutorialId, $manifest) {
    if (($manifest['tutorial_kind'] ?? '') === 'draft_reject' || !empty($manifest['draft_reject_attempt_id'])) {
        $expected = fm_tutorial_normalize_decision($manifest['draft_reject_expected_decision'] ?? '');
        $submitted = fm_tutorial_normalize_decision($manifest['draft_reject_decision'] ?? '');
        $submittedReason = trim((string)($manifest['draft_reject_rejection_reason'] ?? ''));
        $correct = $expected !== '' && $submitted !== '' && $expected === $submitted;
        return [
            'score_status' => 'scored',
            'score' => $correct ? 100.0 : 0.0,
            'details' => [
                'score' => $correct ? 100.0 : 0.0,
                'status' => 'scored',
                'max_score' => 100,
                'grading_version' => FIRSTMEASURE_TUTORIAL_GRADING_VERSION,
                'categories' => [
                    'decision' => [
                        'key' => 'decision',
                        'label' => 'Draft or reject',
                        'score' => $correct ? 100.0 : 0.0,
                        'max_score' => 100,
                        'status' => $correct ? 'correct' : 'missed',
                        'message' => $correct ? 'Decision matched the answer key.' : 'Decision did not match the answer key.',
                        'expected_decision' => $expected,
                        'submitted_decision' => $submitted,
                        'submitted_rejection_reason' => $submittedReason
                    ]
                ],
                'scored_at' => gmdate('c')
            ],
            'scored_at' => gmdate('c')
        ];
    }

    $score = null;
    $details = null;
    if (function_exists('fm_tutorial_calculate_project_score')) {
        $result = fm_tutorial_calculate_project_score($courseId, $userEmail, $tutorialId, $manifest);
        if (is_array($result)) {
            $score = $result['score'] ?? null;
            $details = $result;
        } else {
            $score = $result;
        }
    }
    if (is_numeric($score)) {
        if (is_array($details)) $details['grading_version'] = FIRSTMEASURE_TUTORIAL_GRADING_VERSION;
        return [
            'score_status' => 'scored',
            'score' => max(0, min(100, (float)$score)),
            'details' => $details,
            'scored_at' => gmdate('c')
        ];
    }
    return [
        'score_status' => 'calculating',
        'score' => null,
        'details' => $details,
        'scored_at' => null
    ];
}

function fm_tutorial_public_project_score($manifest) {
    $details = is_array($manifest['tutorial_score_details'] ?? null) ? $manifest['tutorial_score_details'] : [];
    $categories = [];
    foreach (($details['categories'] ?? []) as $key => $category) {
        if (!is_array($category)) continue;
        $categories[$key] = array_intersect_key($category, array_flip([
            'key',
            'label',
            'score',
            'max_score',
            'diff_percent',
            'status',
            'message'
        ]));
    }
    return [
        'score' => is_numeric($manifest['tutorial_score'] ?? null) ? (float)$manifest['tutorial_score'] : null,
        'score_status' => $manifest['tutorial_score_status'] ?? 'calculating',
        'scored_at' => $manifest['tutorial_scored_at'] ?? null,
        'categories' => $categories
    ];
}

function fm_tutorial_update_attempt_final_score($attempt) {
    $ids = is_array($attempt['tutorial_project_ids'] ?? null) ? $attempt['tutorial_project_ids'] : [];
    $scores = is_array($attempt['project_scores'] ?? null) ? $attempt['project_scores'] : [];
    $weights = is_array($attempt['project_weights'] ?? null) ? $attempt['project_weights'] : [];
    $weighted = 0.0;
    $totalWeight = 0.0;
    foreach ($ids as $idx => $id) {
        $entry = is_array($scores[$id] ?? null) ? $scores[$id] : [];
        if (!is_numeric($entry['score'] ?? null)) {
            $attempt['score_status'] = 'calculating';
            $attempt['status'] = 'calculating';
            unset($attempt['final_score']);
            unset($attempt['passed']);
            return $attempt;
        }
        $weight = is_numeric($weights[$id] ?? null) ? max(0, (float)$weights[$id]) : 1.0;
        if ($weight <= 0) $weight = 1.0;
        $weighted += ((float)$entry['score']) * $weight;
        $totalWeight += $weight;
    }
    if ($ids && $totalWeight > 0) {
        $finalScore = round($weighted / $totalWeight, 2);
        $passing = max(0, min(100, (float)($attempt['passing_score_percent'] ?? 80)));
        $attempt['final_score'] = $finalScore;
        $attempt['passed'] = $finalScore >= $passing;
        $attempt['score_status'] = 'graded';
        $attempt['status'] = 'graded';
        $attempt['graded_at'] = gmdate('c');
        $attempt['grading_version'] = FIRSTMEASURE_TUTORIAL_GRADING_VERSION;
    }
    return $attempt;
}

function fm_tutorial_refresh_test_attempt_scores($courseId, $userEmail) {
    $progress = fm_tutorial_read_progress($courseId, $userEmail);
    if (!is_array($progress['test_attempts'] ?? null) || !$progress['test_attempts']) return $progress;

    $changed = false;
    foreach ($progress['test_attempts'] as $attemptId => $attempt) {
        if (!is_array($attempt)) continue;
        $ids = is_array($attempt['tutorial_project_ids'] ?? null) ? $attempt['tutorial_project_ids'] : [];
        if (!$ids) continue;
        if (!isset($attempt['project_scores']) || !is_array($attempt['project_scores'])) $attempt['project_scores'] = [];

        $completed = 0;
        foreach ($ids as $id) {
            $found = fm_tutorial_find_project($id, $userEmail, $courseId);
            if (!$found) continue;
            $manifest = $found['manifest'];
            $status = strtolower((string)($manifest['status'] ?? ''));
            $isComplete = strpos($status, 'completed') !== false || strpos($status, 'locked') !== false || !empty($manifest['locked_for_student']);
            if ($isComplete) $completed++;
            if (!$isComplete) continue;

            $gradingVersion = (int)($manifest['tutorial_grading_version'] ?? ($manifest['tutorial_score_details']['grading_version'] ?? 0));
            if (!is_numeric($manifest['tutorial_score'] ?? null) || $gradingVersion < FIRSTMEASURE_TUTORIAL_GRADING_VERSION) {
                $scoreResult = fm_tutorial_score_project_instance($found['course_id'], $userEmail, $id, $manifest);
                $manifest['tutorial_score_status'] = $scoreResult['score_status'];
                $manifest['tutorial_score'] = $scoreResult['score'];
                $manifest['tutorial_score_details'] = $scoreResult['details'];
                $manifest['tutorial_scored_at'] = $scoreResult['scored_at'];
                $manifest['tutorial_grading_version'] = FIRSTMEASURE_TUTORIAL_GRADING_VERSION;
                $manifest['updated_at'] = gmdate('c');
                fm_tutorial_write_json_file($found['dir'] . 'manifest.json', $manifest);
                $changed = true;
            }

            $attempt['project_scores'][$id] = fm_tutorial_public_project_score($manifest);
        }

        $attempt['completed_count'] = min($completed, count($ids));
        if ($completed >= count($ids)) {
            if (empty($attempt['completed_at'])) $attempt['completed_at'] = $attempt['updated_at'] ?? gmdate('c');
            $attempt = fm_tutorial_update_attempt_final_score($attempt);
        }
        $progress['test_attempts'][$attemptId] = $attempt;
        $changed = true;
    }

    if ($changed) fm_tutorial_write_progress($courseId, $userEmail, $progress);
    return $progress;
}

function fm_tutorial_build_test_completion_context($tutorialId, $userEmail, $courseId, $manifest, &$progress) {
    $attemptId = (string)($manifest['test_attempt_id'] ?? '');
    $attempt = is_array($progress['test_attempts'][$attemptId] ?? null) ? $progress['test_attempts'][$attemptId] : null;
    if (!$attempt) {
        return ['kind' => 'test', 'completed' => 1, 'total' => (int)($manifest['test_sequence_total'] ?? 1), 'label' => 'Test progress saved', 'next_project' => null, 'test_complete' => false];
    }

    $ids = is_array($attempt['tutorial_project_ids'] ?? null) ? $attempt['tutorial_project_ids'] : [];
    $completed = 0;
    $nextProject = null;
    foreach ($ids as $id) {
        $found = fm_tutorial_find_project($id, $userEmail, $courseId);
        if (!$found) continue;
        $pm = $found['manifest'];
        $status = strtolower((string)($pm['status'] ?? ''));
        if (strpos($status, 'completed') !== false || strpos($status, 'locked') !== false || $id === $tutorialId) {
            $completed++;
            continue;
        }
        if ($nextProject === null && empty($pm['locked_for_student'])) {
            $nextProject = [
                'tutorial_id' => $id,
                'editor_url' => 'editor.php?tutorial=1&folder=' . rawurlencode((string)$id) . '&course_id=' . rawurlencode($courseId)
            ];
        }
    }

    $total = max(1, count($ids));
    $complete = $completed >= $total;
    $attempt['completed_count'] = min($completed, $total);
    $attempt['updated_at'] = gmdate('c');
    if (!isset($attempt['project_scores']) || !is_array($attempt['project_scores'])) $attempt['project_scores'] = [];
    $attempt['project_scores'][$tutorialId] = fm_tutorial_public_project_score($manifest);
    if ($complete) {
        $attempt['completed_at'] = gmdate('c');
        $attempt = fm_tutorial_update_attempt_final_score($attempt);
        fm_tutorial_lock_test_attempt_projects($courseId, $userEmail, $attempt);
    }
    $progress['test_attempts'][$attemptId] = $attempt;

    return [
        'kind' => 'test',
        'attempt_id' => $attemptId,
        'completed' => min($completed, $total),
        'total' => $total,
        'label' => min($completed, $total) . ' of ' . $total . ' completed',
        'next_project' => $complete ? null : $nextProject,
        'test_complete' => $complete,
        'redirect_url' => $complete ? './?view=tutorials&test_attempt=' . rawurlencode($attemptId) : null
    ];
}

function fm_tutorial_build_draft_reject_completion_context($tutorialId, $userEmail, $courseId, $manifest, &$progress) {
    $attemptId = (string)($manifest['draft_reject_attempt_id'] ?? '');
    $attempt = is_array($progress['test_attempts'][$attemptId] ?? null) ? $progress['test_attempts'][$attemptId] : null;
    if (!$attempt) {
        return ['kind' => 'draft_reject', 'completed' => 1, 'total' => (int)($manifest['draft_reject_sequence_total'] ?? 1), 'label' => 'Round progress saved', 'next_project' => null, 'test_complete' => false];
    }

    $ids = is_array($attempt['tutorial_project_ids'] ?? null) ? $attempt['tutorial_project_ids'] : [];
    $completed = 0;
    $nextProject = null;
    foreach ($ids as $id) {
        $found = fm_tutorial_find_project($id, $userEmail, $courseId);
        if (!$found) continue;
        $pm = $found['manifest'];
        $status = strtolower((string)($pm['status'] ?? ''));
        if (strpos($status, 'completed') !== false || strpos($status, 'locked') !== false || $id === $tutorialId) {
            $completed++;
            continue;
        }
        if ($nextProject === null && empty($pm['locked_for_student'])) {
            $nextProject = [
                'tutorial_id' => $id,
                'editor_url' => 'editor.php?tutorial=1&folder=' . rawurlencode((string)$id) . '&course_id=' . rawurlencode($courseId)
            ];
        }
    }

    $total = max(1, count($ids));
    $complete = $completed >= $total;
    $attempt['completed_count'] = min($completed, $total);
    $attempt['updated_at'] = gmdate('c');
    if (!isset($attempt['project_scores']) || !is_array($attempt['project_scores'])) $attempt['project_scores'] = [];
    $attempt['project_scores'][$tutorialId] = fm_tutorial_public_project_score($manifest);
    if ($complete) {
        $attempt['completed_at'] = gmdate('c');
        $attempt = fm_tutorial_update_attempt_final_score($attempt);
        fm_tutorial_lock_test_attempt_projects($courseId, $userEmail, $attempt);
    }
    $progress['test_attempts'][$attemptId] = $attempt;

    return [
        'kind' => 'draft_reject',
        'attempt_id' => $attemptId,
        'mode' => $attempt['mode'] ?? 'practice',
        'completed' => min($completed, $total),
        'total' => $total,
        'label' => min($completed, $total) . ' of ' . $total . ' completed',
        'next_project' => $complete ? null : $nextProject,
        'test_complete' => $complete,
        'final_score' => $complete && is_numeric($attempt['final_score'] ?? null) ? (float)$attempt['final_score'] : null,
        'passing_score_percent' => is_numeric($attempt['passing_score_percent'] ?? null) ? (float)$attempt['passing_score_percent'] : null,
        'passed' => $complete ? (($attempt['passed'] ?? null) === true) : null,
        'redirect_url' => $complete ? './?view=tutorials&draft_reject_attempt=' . rawurlencode($attemptId) : null
    ];
}

function fm_tutorial_build_completion_context($tutorialId, $userEmail, $courseId, $manifest, &$progress) {
    if (($manifest['tutorial_kind'] ?? '') === 'draft_reject' || !empty($manifest['draft_reject_attempt_id'])) {
        return fm_tutorial_build_draft_reject_completion_context($tutorialId, $userEmail, $courseId, $manifest, $progress);
    }
    if (($manifest['tutorial_kind'] ?? 'practice') === 'test' || !empty($manifest['test_attempt_id'])) {
        return fm_tutorial_build_test_completion_context($tutorialId, $userEmail, $courseId, $manifest, $progress);
    }
    return fm_tutorial_build_practice_completion_context($tutorialId, $userEmail, $courseId, $manifest, $progress);
}

function fm_tutorial_start_test_attempt($courseId, $userEmail, $chapterId, $testId = null) {
    $curriculum = fm_tutorial_read_curriculum($courseId);
    $chapters = is_array($curriculum['chapters'] ?? null) ? $curriculum['chapters'] : [];
    $chapterIdx = max(0, ((int)$chapterId) - 1);
    $chapter = $chapters[$chapterIdx] ?? null;
    if (!is_array($chapter)) return ['success' => false, 'error' => 'Test chapter not found.'];
    $test = fm_tutorial_find_test_section($chapter, $testId);
    if (!$test) {
        return ['success' => false, 'error' => 'This chapter does not include a test section.'];
    }
    $testId = (string)($test['id'] ?? 'test_1');

    $progress = fm_tutorial_read_progress($courseId, $userEmail);
    $waitHours = max(0, (int)($test['retake_wait_hours'] ?? 0));
    $retakeable = (bool)($test['retakeable'] ?? true);
    foreach ($progress['test_attempts'] as $attempt) {
        if (is_array($attempt) && ($attempt['type'] ?? '') === 'draft_reject') continue;
        if (!is_array($attempt) || (string)($attempt['chapter_id'] ?? '') !== (string)($chapterIdx + 1)) continue;
        if ((string)($attempt['test_id'] ?? 'test_1') !== $testId) continue;
        if (($attempt['status'] ?? '') === 'in_progress') {
            $ids = is_array($attempt['tutorial_project_ids'] ?? null) ? $attempt['tutorial_project_ids'] : [];
            foreach ($ids as $id) {
                $found = fm_tutorial_find_project($id, $userEmail, $courseId);
                if ($found && empty($found['manifest']['locked_for_student'])) {
                    return [
                        'success' => true,
                        'attempt_id' => $attempt['id'] ?? '',
                        'folder' => $id,
                        'editor_url' => 'editor.php?tutorial=1&folder=' . rawurlencode((string)$id) . '&course_id=' . rawurlencode($courseId)
                    ];
                }
            }
        }
        if (!$retakeable) return ['success' => false, 'error' => 'This test cannot be retaken.'];
        if ($waitHours > 0 && !empty($attempt['completed_at'])) {
            $readyAt = strtotime((string)$attempt['completed_at']) + ($waitHours * 3600);
            if ($readyAt > time()) {
                return ['success' => false, 'error' => 'This test is not available for retake yet.'];
            }
        }
    }

    $pool = fm_tutorial_chapter_project_list(['test_projects' => $test['projects'] ?? []], true);
    if (!$pool) return ['success' => false, 'error' => 'This test has no project pool.'];
    shuffle($pool);
    $sampleCount = max(1, (int)($test['sample_count'] ?? min(5, count($pool))));
    $selected = array_slice($pool, 0, min($sampleCount, count($pool)));
    $attemptId = 'test_' . bin2hex(random_bytes(12));
    $startedAt = gmdate('c');
    $timeLimitMinutes = max(0, (int)($test['time_limit_minutes'] ?? 0));
    $passingScorePercent = max(0, min(100, (int)($test['passing_score_percent'] ?? 80)));
    $dueAt = $timeLimitMinutes > 0 ? gmdate('c', time() + ($timeLimitMinutes * 60)) : null;

    $tutorialIds = [];
    foreach ($selected as $idx => $project) {
        $created = fm_tutorial_create_project_instance($project['source_project_id'], $courseId, $userEmail, $chapterIdx + 1, [
            'tutorial_kind' => 'test',
            'test_attempt_id' => $attemptId,
            'test_id' => $testId,
            'test_title' => $test['title'] ?? 'Test',
            'test_sequence_index' => $idx + 1,
            'test_sequence_total' => count($selected),
            'test_started_at' => $startedAt,
            'test_due_at' => $dueAt
        ]);
        if (empty($created['success'])) continue;
        $tutorialIds[] = $created['tutorial_id'];
    }
    if (!$tutorialIds) return ['success' => false, 'error' => 'Could not create test project instances.'];

    $progress['test_attempts'][$attemptId] = [
        'id' => $attemptId,
        'chapter_id' => $chapterIdx + 1,
        'test_id' => $testId,
        'test_title' => $test['title'] ?? 'Test',
        'status' => 'in_progress',
        'score_status' => 'hidden',
        'started_at' => $startedAt,
        'due_at' => $dueAt,
        'time_limit_minutes' => $timeLimitMinutes,
        'passing_score_percent' => $passingScorePercent,
        'sample_count' => count($tutorialIds),
        'completed_count' => 0,
        'project_scores' => [],
        'project_weights' => [],
        'tutorial_project_ids' => $tutorialIds,
        'source_project_ids' => array_map(function($project) { return $project['source_project_id']; }, $selected)
    ];
    foreach ($selected as $idx => $project) {
        $tid = $tutorialIds[$idx] ?? null;
        if ($tid) $progress['test_attempts'][$attemptId]['project_weights'][$tid] = is_numeric($project['weight'] ?? null) ? (float)$project['weight'] : 1;
    }
    fm_tutorial_write_progress($courseId, $userEmail, $progress);

    return [
        'success' => true,
        'attempt_id' => $attemptId,
        'folder' => $tutorialIds[0],
        'editor_url' => 'editor.php?tutorial=1&folder=' . rawurlencode((string)$tutorialIds[0]) . '&course_id=' . rawurlencode($courseId)
    ];
}

function fm_tutorial_start_draft_reject_round($courseId, $userEmail, $chapterId, $roundId = null) {
    $curriculum = fm_tutorial_read_curriculum($courseId);
    $chapters = is_array($curriculum['chapters'] ?? null) ? $curriculum['chapters'] : [];
    $chapterIdx = max(0, ((int)$chapterId) - 1);
    $chapter = $chapters[$chapterIdx] ?? null;
    if (!is_array($chapter)) return ['success' => false, 'error' => 'Round chapter not found.'];

    $rounds = fm_tutorial_normalize_draft_reject_rounds($chapter);
    if (!$rounds) return ['success' => false, 'error' => 'This chapter does not include a draft/reject round.'];
    $roundId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)$roundId);
    $round = null;
    foreach ($rounds as $candidate) {
        if ($roundId !== '' && ($candidate['id'] ?? '') !== $roundId) continue;
        $round = $candidate;
        break;
    }
    if (!$round) $round = $rounds[0];

    $progress = fm_tutorial_read_progress($courseId, $userEmail);
    $mode = ($round['mode'] ?? 'practice') === 'test' ? 'test' : 'practice';
    $waitHours = max(0, (int)($round['retake_wait_hours'] ?? 0));
    foreach ($progress['test_attempts'] as $attempt) {
        if (!is_array($attempt) || ($attempt['type'] ?? '') !== 'draft_reject') continue;
        if ((string)($attempt['chapter_id'] ?? '') !== (string)($chapterIdx + 1)) continue;
        if ((string)($attempt['round_id'] ?? '') !== (string)($round['id'] ?? '')) continue;
        if (($attempt['status'] ?? '') === 'in_progress') {
            foreach ((array)($attempt['tutorial_project_ids'] ?? []) as $id) {
                $found = fm_tutorial_find_project($id, $userEmail, $courseId);
                if ($found && empty($found['manifest']['locked_for_student'])) {
                    return [
                        'success' => true,
                        'attempt_id' => $attempt['id'] ?? '',
                        'folder' => $id,
                        'editor_url' => 'editor.php?tutorial=1&folder=' . rawurlencode((string)$id) . '&course_id=' . rawurlencode($courseId)
                    ];
                }
            }
        }
        if ($mode === 'test' && $waitHours > 0 && !empty($attempt['completed_at'])) {
            $readyAt = strtotime((string)$attempt['completed_at']) + ($waitHours * 3600);
            if ($readyAt > time()) return ['success' => false, 'error' => 'This round is not available for retake yet.'];
        }
    }

    $pool = is_array($round['projects'] ?? null) ? $round['projects'] : [];
    if (!$pool) return ['success' => false, 'error' => 'This draft/reject round has no project pool.'];
    shuffle($pool);
    $sampleCount = max(1, (int)($round['sample_count'] ?? min(5, count($pool))));
    $selected = array_slice($pool, 0, min($sampleCount, count($pool)));
    $attemptId = 'draft_reject_' . bin2hex(random_bytes(12));
    $startedAt = gmdate('c');
    $passingScorePercent = max(0, min(100, (int)($round['passing_score_percent'] ?? 80)));

    $tutorialIds = [];
    foreach ($selected as $idx => $project) {
        $created = fm_tutorial_create_project_instance($project['source_project_id'], $courseId, $userEmail, $chapterIdx + 1, [
            'tutorial_kind' => 'draft_reject',
            'draft_reject_attempt_id' => $attemptId,
            'draft_reject_round_id' => $round['id'] ?? '',
            'draft_reject_title' => $round['title'] ?? 'Draft or Reject',
            'draft_reject_mode' => $mode,
            'draft_reject_expected_decision' => fm_tutorial_normalize_decision($project['correct_decision'] ?? 'draft') ?: 'draft',
            'draft_reject_sequence_index' => $idx + 1,
            'draft_reject_sequence_total' => count($selected),
            'draft_reject_started_at' => $startedAt,
            'curriculum_project_id' => $project['curriculum_project_id'] ?? '',
            'practice_project_name' => $project['name'] ?? ''
        ]);
        if (empty($created['success'])) continue;
        $tutorialIds[] = $created['tutorial_id'];
    }
    if (!$tutorialIds) return ['success' => false, 'error' => 'Could not create draft/reject project instances.'];

    $progress['test_attempts'][$attemptId] = [
        'id' => $attemptId,
        'type' => 'draft_reject',
        'mode' => $mode,
        'chapter_id' => $chapterIdx + 1,
        'round_id' => $round['id'] ?? '',
        'round_title' => $round['title'] ?? 'Draft or Reject',
        'status' => 'in_progress',
        'score_status' => 'hidden',
        'started_at' => $startedAt,
        'passing_score_percent' => $passingScorePercent,
        'sample_count' => count($tutorialIds),
        'completed_count' => 0,
        'project_scores' => [],
        'project_weights' => array_fill_keys($tutorialIds, 1),
        'tutorial_project_ids' => $tutorialIds,
        'source_project_ids' => array_map(function($project) { return $project['source_project_id']; }, $selected)
    ];
    fm_tutorial_write_progress($courseId, $userEmail, $progress);

    return [
        'success' => true,
        'attempt_id' => $attemptId,
        'folder' => $tutorialIds[0],
        'editor_url' => 'editor.php?tutorial=1&folder=' . rawurlencode((string)$tutorialIds[0]) . '&course_id=' . rawurlencode($courseId)
    ];
}

function fm_tutorial_list_user_projects($userEmail, $courseId = null) {
    $safeUser = fm_tutorial_safe_user($userEmail);
    $root = storageDir('tutorials/users/' . $safeUser . '/courses');
    $projects = [];
    $courses = [];
    if ($courseId !== null && $courseId !== '') {
        $courses[] = (string)$courseId;
    } elseif (is_dir($root)) {
        foreach (scandir($root) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') continue;
            if (is_dir($root . '/' . $entry)) $courses[] = $entry;
        }
    }
    if (!$courses) $courses[] = 'default';
    foreach (array_unique($courses) as $cid) {
        $dir = fm_tutorial_user_projects_dir($cid, $userEmail);
        foreach (scandir($dir) ?: [] as $id) {
            if ($id === '.' || $id === '..' || !fm_tutorial_is_tutorial_project_id($id)) continue;
            $manifest = fm_tutorial_read_json_file($dir . $id . '/manifest.json', []);
            if (!$manifest) continue;
            $projects[] = array_merge($manifest, [
                'id' => $id,
                'folder' => $id,
                'is_tutorial_instance' => true,
                'tutorial_course_id' => $cid,
                'original_master_id' => $manifest['source_project_id'] ?? ($manifest['original_master_id'] ?? '')
            ]);
        }
    }
    usort($projects, function($a, $b) {
        return strcmp((string)($b['updated_at'] ?? $b['created_at'] ?? ''), (string)($a['updated_at'] ?? $a['created_at'] ?? ''));
    });
    return $projects;
}
