<?php
require_once __DIR__ . '/_storage.php';

/**
 * Saves Directory Size Reporter
 * Scans the 'saves' directory and reports disk usage per subdirectory.
 */

$savesDir = __DIR__ . '/saves';

if (!is_dir($savesDir)) {
    echo "Error: 'saves' directory not found at $savesDir\n";
    exit(1);
}

function getDirSize(string $path): int
{
    $size = 0;
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ($iterator as $file) {
        if ($file->isFile()) {
            $size += $file->getSize();
        }
    }

    return $size;
}

function formatBytes(int $bytes, int $precision = 2): string
{
    $units = ['B', 'KB', 'MB', 'GB', 'TB'];
    $factor = floor((strlen((string) $bytes) - 1) / 3);
    $factor = min($factor, count($units) - 1);

    return round($bytes / (1024 ** $factor), $precision) . ' ' . $units[$factor];
}

// Gather subdirectory sizes
$subdirs = [];
$totalSize = 0;
$topLevelFileSize = 0;

foreach (scandir($savesDir) as $entry) {
    if ($entry === '.' || $entry === '..') {
        continue;
    }

    $fullPath = $savesDir . '/' . $entry;

    if (is_dir($fullPath)) {
        $size = getDirSize($fullPath);
        $subdirs[$entry] = $size;
        $totalSize += $size;
    } elseif (is_file($fullPath)) {
        $fileSize = filesize($fullPath);
        $topLevelFileSize += $fileSize;
        $totalSize += $fileSize;
    }
}

// Sort subdirectories by size descending
arsort($subdirs);

// Output results
$isCli = php_sapi_name() === 'cli';
$nl = $isCli ? "\n" : "<br>\n";
$bold = fn($t) => $isCli ? "\033[1m$t\033[0m" : "<b>$t</b>";

if (!$isCli) {
    echo "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Saves Directory Usage</title>";
    echo "<style>body{font-family:monospace;padding:20px}table{border-collapse:collapse}td,th{padding:4px 16px;text-align:left}th{border-bottom:2px solid #333}tr:nth-child(even){background:#f4f4f4}.total{font-weight:bold;border-top:2px solid #333}</style>";
    echo "</head><body>";
    echo "<h2>Saves Directory Usage</h2>";
    echo "<table><tr><th>Directory</th><th>Size</th><th>% of Total</th></tr>";

    foreach ($subdirs as $name => $size) {
        $pct = $totalSize > 0 ? round($size / $totalSize * 100, 1) : 0;
        echo "<tr><td>$name/</td><td>" . formatBytes($size) . "</td><td>{$pct}%</td></tr>";
    }

    if ($topLevelFileSize > 0) {
        $pct = round($topLevelFileSize / $totalSize * 100, 1);
        echo "<tr><td>(top-level files)</td><td>" . formatBytes($topLevelFileSize) . "</td><td>{$pct}%</td></tr>";
    }

    echo "<tr class='total'><td>TOTAL</td><td>" . formatBytes($totalSize) . "</td><td>100%</td></tr>";
    echo "</table></body></html>";
} else {
    echo $bold("Saves Directory Usage") . $nl;
    echo str_repeat('-', 50) . $nl;

    $nameWidth = 30;
    $sizeWidth = 12;

    printf("%-{$nameWidth}s %{$sizeWidth}s %8s$nl", "Directory", "Size", "% Total");
    echo str_repeat('-', 50) . $nl;

    foreach ($subdirs as $name => $size) {
        $pct = $totalSize > 0 ? round($size / $totalSize * 100, 1) : 0;
        printf("%-{$nameWidth}s %{$sizeWidth}s %7s%%$nl", $name . '/', formatBytes($size), $pct);
    }

    if ($topLevelFileSize > 0) {
        $pct = round($topLevelFileSize / $totalSize * 100, 1);
        printf("%-{$nameWidth}s %{$sizeWidth}s %7s%%$nl", "(top-level files)", formatBytes($topLevelFileSize), $pct);
    }

    echo str_repeat('-', 50) . $nl;
    printf("%-{$nameWidth}s %{$sizeWidth}s %8s$nl", "TOTAL", formatBytes($totalSize), "100%");
}