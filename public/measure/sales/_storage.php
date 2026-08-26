<?php
declare(strict_types=1);

function firstmateSalesPublicRoot(): string {
    return dirname(__DIR__, 2);
}

function firstmateSalesStorageNormalizeRelativePath(string $relative): string {
    $relative = str_replace('\\', '/', $relative);
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

function firstmateSalesStorageRoot(string $area): string {
    $area = firstmateSalesStorageNormalizeRelativePath($area);
    if ($area === '') {
        $area = 'shared';
    }

    $root = firstmateSalesPublicRoot() . '/storage/measure/sales/' . $area;
    if (!is_dir($root)) {
        @mkdir($root, 0775, true);
    }
    return $root;
}

function firstmateSalesLegacyStorageRoot(string $area): string {
    $area = firstmateSalesStorageNormalizeRelativePath($area);
    return __DIR__ . '/' . $area . '/storage';
}

function firstmateSalesStoragePath(string $area, string $relative = '', bool $ensureParent = false): string {
    $relative = firstmateSalesStorageNormalizeRelativePath($relative);
    $path = firstmateSalesStorageRoot($area) . ($relative !== '' ? '/' . $relative : '');

    if ($ensureParent) {
        $parent = dirname($path);
        if (!is_dir($parent)) {
            @mkdir($parent, 0775, true);
        }
    }

    return $path;
}

function firstmateSalesStorageDir(string $area, string $relative = ''): string {
    $path = firstmateSalesStoragePath($area, $relative);
    if (!is_dir($path)) {
        @mkdir($path, 0775, true);
    }
    return rtrim($path, '/\\');
}

function firstmateSalesExistingStoragePath(string $area, string $relative = '', bool $ensureParent = false): string {
    $relative = firstmateSalesStorageNormalizeRelativePath($relative);
    $storage = firstmateSalesStoragePath($area, $relative, $ensureParent);
    if (file_exists($storage)) return $storage;

    $legacy = firstmateSalesLegacyStorageRoot($area) . ($relative !== '' ? '/' . $relative : '');
    if (file_exists($legacy)) return $legacy;

    return $storage;
}
