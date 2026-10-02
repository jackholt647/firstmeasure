<?php
// Content versions are shared by the portal and its isolated project windows.
// A timestamp per request forces every window to download the entire shell again.
function portalAssetVersion(string $relativePath): string {
    static $versions = [];
    if (!isset($versions[$relativePath])) {
        $path = __DIR__ . '/' . $relativePath;
        $hash = is_file($path) ? hash_file('sha256', $path) : false;
        $versions[$relativePath] = $hash ? substr($hash, 0, 16) : 'missing';
    }
    return $versions[$relativePath];
}
