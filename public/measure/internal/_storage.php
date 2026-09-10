<?php
/**
 * Central filesystem storage paths for the internal app.
 *
 * Keep mutable app data under ./storage so code updates can be deployed without
 * overwriting databases, JSON stores, logs, uploads, or generated cache files.
 */

function storageRoot() {
    static $root = null;
    if ($root !== null) return $root;

    $root = storagePublicRoot() . '/storage/measure/internal';
    if (!is_dir($root)) {
        @mkdir($root, 0775, true);
    }
    return $root;
}

function storagePublicRoot() {
    return dirname(__DIR__, 2);
}

function storageNormalizeRelativePath($relative) {
    $relative = str_replace('\\', '/', (string)$relative);
    $relative = preg_replace('#/+#', '/', $relative);
    $relative = ltrim($relative, '/');

    $parts = [];
    foreach (explode('/', $relative) as $part) {
        if ($part === '' || $part === '.') continue;
        if ($part === '..') continue;
        $parts[] = $part;
    }
    return implode('/', $parts);
}

function storagePath($relative = '', $ensureParent = false) {
    $relative = storageNormalizeRelativePath($relative);
    $path = storageRoot() . ($relative !== '' ? '/' . $relative : '');
    // Tutorial editor/grading writes must share Node's configured writable
    // root after the cutover, rather than starting a second progress tree.
    $tutorialRoot = getenv('MEASURE_INTERNAL_TUTORIALS_ROOT') ?: getenv('TUTORIALS_STORAGE_ROOT');
    if ($tutorialRoot && ($relative === 'tutorials' || strpos($relative, 'tutorials/') === 0)) {
        $path = rtrim($tutorialRoot, '/\\') . substr($relative, strlen('tutorials'));
    }

    if ($ensureParent) {
        $parent = dirname($path);
        if (!is_dir($parent)) {
            @mkdir($parent, 0775, true);
        }
    }

    return $path;
}

function storageDir($relative = '') {
    $path = storagePath($relative);
    if (!is_dir($path)) {
        @mkdir($path, 0775, true);
    }
    return rtrim($path, '/\\') . '/';
}

function storagePublicRelativePath($relative = '') {
    $relative = storageNormalizeRelativePath($relative);
    return '/storage/measure/internal' . ($relative !== '' ? '/' . $relative : '');
}
