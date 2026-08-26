<?php
/**
 * Copy this file to sync-key.php on every environment that is allowed to use
 * public/sync.php. Never expose sync-key.php through source control, chat, logs,
 * or browser output.
 */
if (!defined('FIRSTMATE_SYNC_KEY_ALLOWED')) {
    http_response_code(404);
    exit;
}

return [
    'key_id' => 'firstmate-sync-main',
    'secret' => 'replace-with-64-plus-random-hex-characters',

    // Optional. Leave blank until the production restart command is known.
    // Example:
    // 'node_restart_command' => 'cd /var/www/ide/v1 && npm run build && pm2 restart firstmate-v1',
    'node_restart_command' => getenv('FIRSTMATE_SYNC_NODE_RESTART') ?: '',
];
