<?php
declare(strict_types=1);

// Only frontend/ is public. Never serve a package root, backend, or config.
function fm_external_file(string $root, string $relative): ?string {
    if ($relative === '' || str_contains($relative, "\0") || str_contains($relative, '\\')) return null;
    foreach (explode('/', $relative) as $part) {
        if ($part === '' || $part === '.' || $part === '..' || str_starts_with($part, '.')) return null;
    }
    $base = realpath($root);
    $file = $base === false ? false : realpath($base . '/' . $relative);
    if ($file === false || !str_starts_with($file, $base . DIRECTORY_SEPARATOR) || !is_file($file) || !is_readable($file)) return null;
    $types = ['js', 'css', 'json', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'woff', 'woff2'];
    return in_array(strtolower(pathinfo($file, PATHINFO_EXTENSION)), $types, true) ? $file : null;
}

function fm_external_packages(?string $configPath = null): array {
    $configPath ??= getenv('FIRSTMATE_EXTERNAL_APPS_CONFIG') ?: dirname(__DIR__) . '/external-apps.json';
    $raw = @file_get_contents($configPath);
    $config = $raw === false ? null : json_decode($raw, true);
    if (!is_array($config) || ($config['version'] ?? null) !== 1 || !is_array($config['apps'] ?? null)) return [];
    $packages = [];
    foreach ($config['apps'] as $entry) {
        if (!is_array($entry) || ($entry['enabled'] ?? true) !== true) continue;
        $id = $entry['id'] ?? null;
        $directory = $entry['directory'] ?? null;
        if (!is_string($id) || !preg_match('/^[a-z][a-z0-9-]*$/D', $id) || isset($packages[$id]) || !is_string($directory) || $directory === '' || str_contains($directory, "\0")) continue;
        $absolute = str_starts_with($directory, '/') || preg_match('/^[A-Za-z]:[\\\\\/]/', $directory);
        $root = realpath($absolute ? $directory : dirname($configPath) . '/' . $directory);
        if ($root === false) continue;
        $manifestRaw = @file_get_contents($root . '/firstmate-app.json');
        $manifest = $manifestRaw === false ? null : json_decode($manifestRaw, true);
        if (!is_array($manifest) || ($manifest['version'] ?? null) !== 1 || ($manifest['id'] ?? null) !== $id || !is_string($manifest['title'] ?? null) || !is_string($manifest['entry'] ?? null)) continue;
        $frontend = $root . '/frontend';
        $entryFile = fm_external_file($frontend, $manifest['entry']);
        if ($entryFile === null || pathinfo($entryFile, PATHINFO_EXTENSION) !== 'js') continue;
        $packages[$id] = ['id' => $id, 'frontend' => $frontend, 'manifest' => $manifest];
    }
    return $packages;
}

function fm_external_render(): void {
    foreach (fm_external_packages() as $package) {
        $manifest = $package['manifest'];
        $meta = [
            'id' => $package['id'], 'title' => $manifest['title'],
            'icon' => is_string($manifest['icon'] ?? null) ? $manifest['icon'] : 'fa-flask',
            'order' => is_numeric($manifest['order'] ?? null) ? (float)$manifest['order'] : 900,
        ];
        $json = json_encode($meta, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
        $url = '/external-apps/asset.php?app=' . rawurlencode($package['id']) . '&file=' . rawurlencode($manifest['entry']);
        echo '<script src="' . htmlspecialchars($url, ENT_QUOTES) . '"></script>' . "\n";
        echo '<script>window.FirstMateExternalApps?.register(' . $json . ');</script>' . "\n";
    }
}
