<?php

$source = file_get_contents(__DIR__ . '/../../index.php');
if ($source === false) {
    fwrite(STDERR, "Missing public root entry point.\n");
    exit(1);
}
if (!str_contains($source, "header('Location: /portal/', true, 302)")) {
    fwrite(STDERR, "Root entry point must redirect to the portal with a relative URL.\n");
    exit(1);
}
if (preg_match('#https?://#i', $source)) {
    fwrite(STDERR, "Root redirect must not hard-code a scheme or host.\n");
    exit(1);
}
echo json_encode(['ok' => true, 'location' => '/portal/']) . PHP_EOL;
