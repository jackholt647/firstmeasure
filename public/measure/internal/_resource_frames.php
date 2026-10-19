<?php
// Server-side video frame extraction for internal Resources.
// The browser sends only a video resource name and a timestamp; this file
// assembles the stored video, decodes the frame with ffmpeg and publishes the
// PNG as an ordinary chunked resource. Storage is injected so tests can run
// the whole job without the artifact API.

const FM_RESOURCE_FRAME_CHUNK_BYTES = 8 * 1024 * 1024;
const FM_RESOURCE_FRAME_CACHE_SECONDS = 3600;

function fm_resource_frame_name_valid($name) {
    return is_string($name) && strlen($name) <= 100
        && preg_match('/^internal-resource-v2-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-zA-Z0-9._-]*\.png$/D', $name) === 1;
}
function fm_resource_frame_source_valid($name) {
    return is_string($name) && strlen($name) <= 100
        && preg_match('/^internal-resource-[a-zA-Z0-9._-]+\.(mp4|webm|mov|m4v)$/Di', $name) === 1;
}
function fm_resource_frame_job_name($frameName) {
    return 'internal-markup-framejob-' . substr($frameName, strlen('internal-resource-v2-'), 36) . '.json';
}
function fm_resource_ffmpeg_path() {
    $configured = getenv('FIRSTMEASURE_FFMPEG');
    return $configured !== false && $configured !== '' ? $configured : 'ffmpeg';
}
function fm_resource_part_name($id, $index) {
    return 'internal-markup-part-' . $id . '-' . str_pad((string)$index, 8, '0', STR_PAD_LEFT) . '.bin';
}

// Runs a command without a shell. Returns [exit code, stderr]; throws on timeout.
function fm_resource_run(array $command, $timeoutSeconds) {
    $log = tempnam(sys_get_temp_dir(), 'fmffmpeg');
    $null = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
    try {
        $process = @proc_open($command, [0 => ['file', $null, 'r'], 1 => ['file', $null, 'w'], 2 => ['file', $log, 'w']], $pipes, null, null, ['bypass_shell' => true]);
        if (!is_resource($process)) throw new RuntimeException('Frame extraction is not available on this server (ffmpeg could not be started).');
        $deadline = microtime(true) + $timeoutSeconds;
        while (($status = proc_get_status($process))['running']) {
            if (microtime(true) > $deadline) { proc_terminate($process, 9); proc_close($process); throw new RuntimeException('Frame extraction timed out.'); }
            usleep(20000);
        }
        proc_close($process);
        // Exit code 127 (POSIX) or 9009 (Windows) means the binary is missing.
        if (in_array($status['exitcode'], [127, 9009], true)) throw new RuntimeException('Frame extraction is not available on this server (ffmpeg is not installed).');
        return [$status['exitcode'], (string)file_get_contents($log)];
    } finally { @unlink($log); }
}

// Returns the PNG of the frame a browser shows at $time: the last frame whose
// presentation time is at or before $time. Decoding starts up to three
// seconds earlier so the choice does not depend on keyframe placement.
function fm_resource_extract_frame($videoPath, $time, $ffmpeg = null) {
    $ffmpeg = $ffmpeg ?: fm_resource_ffmpeg_path();
    if (!is_float($time) && !is_int($time) || !is_finite((float)$time) || $time < 0) throw new InvalidArgumentException('Invalid frame time.');
    $time = (float)$time;
    $start = max(0.0, $time - 3.0);
    $out = tempnam(sys_get_temp_dir(), 'fmframe');
    $png = $out . '.png'; @unlink($out);
    try {
        $fmt = fn($value) => number_format($value, 6, '.', '');
        [$code, $stderr] = fm_resource_run([$ffmpeg, '-nostdin', '-v', 'error', '-y', '-ss', $fmt($start), '-i', $videoPath,
            '-t', $fmt($time - $start + 0.0005), '-map', '0:v:0', '-fps_mode', 'passthrough', '-update', '1', '-c:v', 'png', '-f', 'image2', $png], 120);
        if (!is_file($png) || !filesize($png)) {
            // A timestamp before the first frame: use the first frame instead.
            [$code, $stderr] = fm_resource_run([$ffmpeg, '-nostdin', '-v', 'error', '-y', '-ss', $fmt($time), '-i', $videoPath,
                '-map', '0:v:0', '-frames:v', '1', '-c:v', 'png', '-f', 'image2', $png], 120);
        }
        if ($code !== 0 || !is_file($png) || !filesize($png)) {
            $detail = trim(preg_replace('/\s+/', ' ', (string)$stderr));
            throw new RuntimeException('The video frame could not be decoded' . ($detail !== '' ? ': ' . substr($detail, 0, 200) : '.'));
        }
        $bytes = file_get_contents($png);
        if (strncmp($bytes, "\x89PNG\r\n\x1a\n", 8) !== 0) throw new RuntimeException('The video frame could not be decoded.');
        return $bytes;
    } finally { @unlink($png); }
}

// Writes the stored video to a local file, reusing a recent copy so several
// frames from one walkthrough fetch it once. Part checksums are verified.
function fm_resource_frame_video_file($project, $source, callable $get, $cacheDir = null) {
    $cacheDir = $cacheDir ?: sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'firstmeasure-resource-frames';
    if (!is_dir($cacheDir) && !@mkdir($cacheDir, 0700, true) && !is_dir($cacheDir)) throw new RuntimeException('Frame workspace is unavailable.');
    foreach (glob($cacheDir . DIRECTORY_SEPARATOR . '*') ?: [] as $old) {
        if (is_file($old) && filemtime($old) < time() - FM_RESOURCE_FRAME_CACHE_SECONDS) @unlink($old);
    }
    $raw = $get($source);
    $index = strpos($source, 'internal-resource-v2-') === 0 ? json_decode($raw, true) : null;
    if ($index !== null && (!is_array($index) || ($index['format'] ?? '') !== 'firstmeasure-resource-chunks-v1' || !is_int($index['size'] ?? null))) throw new RuntimeException('The video index is invalid.');
    $ext = strtolower(pathinfo($source, PATHINFO_EXTENSION));
    $key = hash('sha256', $project . "\n" . $source . "\n" . ($index ? json_encode($index['sha256'] ?? $index['size']) : hash('sha256', $raw)));
    $path = $cacheDir . DIRECTORY_SEPARATOR . $key . '.' . $ext;
    $lock = fopen($path . '.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX)) throw new RuntimeException('Frame workspace is unavailable.');
    try {
        $expected = $index ? $index['size'] : strlen($raw);
        if (is_file($path) && filesize($path) === $expected) { touch($path); return $path; }
        $partial = $path . '.partial';
        $out = fopen($partial, 'wb');
        if (!$out) throw new RuntimeException('Frame workspace is unavailable.');
        try {
            if (!$index) fwrite($out, $raw);
            else for ($part = 0; $part < $index['parts']; $part++) {
                $bytes = $get(fm_resource_part_name($index['id'], $part));
                if (isset($index['sha256'][$part]) && !hash_equals($index['sha256'][$part], hash('sha256', $bytes))) throw new RuntimeException('Stored video failed its integrity check.');
                fwrite($out, $bytes);
            }
        } finally { fclose($out); }
        if (filesize($partial) !== $expected) { @unlink($partial); throw new RuntimeException('Stored video is incomplete.'); }
        rename($partial, $path);
        return $path;
    } finally { flock($lock, LOCK_UN); fclose($lock); @unlink($path . '.lock'); }
}

// Stores bytes as a chunked resource (parts first, index last) and returns the index.
function fm_resource_publish_bytes($name, $bytes, array $meta, callable $put) {
    $id = substr($name, strlen('internal-resource-v2-'), 36);
    $size = strlen($bytes); $parts = (int)ceil($size / FM_RESOURCE_FRAME_CHUNK_BYTES); $sha256 = [];
    for ($part = 0; $part < $parts; $part++) {
        $chunk = substr($bytes, $part * FM_RESOURCE_FRAME_CHUNK_BYTES, FM_RESOURCE_FRAME_CHUNK_BYTES);
        $digest = hash('sha256', $chunk);
        $put(fm_resource_part_name($id, $part), $chunk, $digest);
        $sha256[] = $digest;
    }
    $index = ['format' => 'firstmeasure-resource-chunks-v1', 'id' => $id, 'size' => $size, 'chunkSize' => FM_RESOURCE_FRAME_CHUNK_BYTES,
        'parts' => $parts, 'sha256' => $sha256, 'content_type' => 'image/png'] + $meta;
    $put($name, json_encode($index), null);
    return $index;
}

// Runs one frame job. $job: project, frame, source, time, original_name, role,
// actor and optionally favorite {record, label}. Returns the job result.
function fm_resource_frame_run(array $job, callable $get, callable $put, $options = []) {
    $video = fm_resource_frame_video_file($job['project'], $job['source'], $get, $options['cache_dir'] ?? null);
    $png = fm_resource_extract_frame($video, (float)$job['time'], $options['ffmpeg'] ?? null);
    $now = gmdate('c');
    $index = fm_resource_publish_bytes($job['frame'], $png, [
        'original_name' => $job['original_name'], 'project_id' => $job['project'], 'uploaded_at' => $now,
        'uploaded_by' => $job['actor'], 'role' => $job['role'], 'source_video' => ['name' => $job['source'], 'time' => (float)$job['time']],
    ], $put);
    if (!empty($job['favorite'])) {
        $put($job['favorite']['record'], json_encode(['version' => 1, 'label' => (string)$job['favorite']['label'], 'source' => $job['source'],
            'time' => (float)$job['time'], 'frame' => $job['frame'], 'createdAt' => $now]), null);
    }
    return ['status' => 'done', 'frame' => $job['frame'], 'size' => $index['size'], 'finished_at' => $now];
}
