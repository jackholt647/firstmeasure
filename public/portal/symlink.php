<?php
// /app/make_org_symlink.php
// Creates: /app/organizations  ->  /backend/training/measure/organizations

header('Content-Type: text/plain; charset=utf-8');

$docroot = rtrim($_SERVER['DOCUMENT_ROOT'] ?? '', '/');
if (!$docroot || !is_dir($docroot)) {
    http_response_code(500);
    exit("Could not determine DOCUMENT_ROOT.\n");
}

// absolute filesystem paths
$link   = $docroot . '/portal/saves';
$target = $docroot . '/measure/internal/saves';

echo "DOCROOT: $docroot\n";
echo "LINK:    $link\n";
echo "TARGET:  $target\n\n";

if (!is_dir($target)) {
    http_response_code(500);
    exit("Target directory does not exist:\n$target\n");
}

if (is_link($link)) {
    echo "Symlink already exists.\n";
    echo "Currently points to: " . readlink($link) . "\n";
    exit;
}

if (file_exists($link)) {
    http_response_code(409);
    exit("Cannot create symlink because path already exists (not a symlink):\n$link\n");
}

// attempt
if (@symlink($target, $link)) {
    echo "OK: symlink created.\n";
    exit;
}

// show useful error
$error = error_get_last();
http_response_code(500);
echo "FAILED: symlink() returned false.\n";
if ($error) echo "PHP error: {$error['message']}\n";

echo "\nCommon causes:\n";
echo "- PHP user lacks permission to write under /app\n";
echo "- Symlinks are disabled (common on shared hosting)\n";
echo "- open_basedir restriction blocks one of these paths\n";
