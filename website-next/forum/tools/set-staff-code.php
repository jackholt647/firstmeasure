<?php
/* Sets the FirstMate team code for the forum (command line only).
 *   php forum/tools/set-staff-code.php            prompts for the code (hidden on Linux/macOS)
 *   php forum/tools/set-staff-code.php --stdin    reads the code from standard input
 * Writes {"hash": "<bcrypt>"} to staff.json in the forum data directory. */

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

define('FM_FORUM', 1);
require dirname(__DIR__) . '/lib.php';

$fromStdin = in_array('--stdin', $argv, true);
if ($fromStdin) {
    $code = trim((string)stream_get_contents(STDIN));
} else {
    fwrite(STDOUT, 'New team code (at least 10 characters): ');
    $hide = DIRECTORY_SEPARATOR === '/' && function_exists('shell_exec');
    if ($hide) shell_exec('stty -echo');
    $code = trim((string)fgets(STDIN));
    if ($hide) { shell_exec('stty echo'); fwrite(STDOUT, "\n"); }
}

if (strlen($code) < 10) { fwrite(STDERR, "The team code must be at least 10 characters.\n"); exit(1); }
if (strlen($code) > 72) { fwrite(STDERR, "The team code can be at most 72 bytes (bcrypt limit).\n"); exit(1); }

$path = fm_data_dir() . '/staff.json';
fm_locked(true, function () use ($path, $code) {
    fm_write_json($path, ['hash' => password_hash($code, PASSWORD_BCRYPT, ['cost' => 12]), 'updated' => gmdate('c')]);
});
@chmod($path, 0640);
fwrite(STDOUT, "Team code saved to $path\n");
