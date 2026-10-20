<?php
// The signup sandbox mints pre-authenticated test organizations, so it exists only on
// local and development hosts. Every other host (production included) gets no
// sandbox page and no dev bar; /v1/signup-sandbox already answers 404 in production.
if (!function_exists('fm_signup_sandbox_available')) {
    function fm_signup_sandbox_available(): bool {
        $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
        $host = preg_replace('/:\d+$/', '', $host);
        return in_array($host, ['localhost', '127.0.0.1', '[::1]', 'dev.1m8.ai'], true)
            || str_ends_with($host, '.localhost');
    }
}
