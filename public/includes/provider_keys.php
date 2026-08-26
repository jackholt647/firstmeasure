<?php

/**
 * Filesystem-backed provider credentials shared by the PHP pages and Node host.
 * The real file lives outside the public web root at private/provider-keys.json.
 */

function fm_provider_keys_path() {
    return dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'private' . DIRECTORY_SEPARATOR . 'provider-keys.json';
}

function fm_provider_keys_config() {
    static $config = null;
    if (is_array($config)) return $config;

    $config = [];
    $path = fm_provider_keys_path();
    if (!is_file($path) || !is_readable($path)) return $config;

    $raw = file_get_contents($path);
    if (!is_string($raw) || trim($raw) === '') return $config;

    $decoded = json_decode($raw, true);
    if (is_array($decoded)) $config = $decoded;
    return $config;
}

function fm_provider_key_value($section, $name) {
    $config = fm_provider_keys_config();
    $group = isset($config[$section]) && is_array($config[$section]) ? $config[$section] : [];
    return trim((string)($group[$name] ?? ''));
}

function fm_google_provider_key($purpose = 'server') {
    $purpose = strtolower(trim((string)$purpose));
    $specific = [
        'browser' => 'browser_api_key',
        'browser_customer' => 'customer_browser_api_key',
        'browser_internal' => 'internal_browser_api_key',
        'browser_territory' => 'territory_browser_api_key',
        'server' => 'server_api_key',
        'solar' => 'solar_api_key',
        'maps_static' => 'maps_static_api_key',
        'map_tiles' => 'map_tiles_api_key',
        'places' => 'places_api_key'
    ];
    $name = $specific[$purpose] ?? 'server_api_key';
    $key = fm_provider_key_value('google', $name);
    if ($key !== '') return $key;

    if (strpos($purpose, 'browser') !== 0) {
        $server = fm_provider_key_value('google', 'server_api_key');
        if ($server !== '') return $server;
    } else {
        $browser = fm_provider_key_value('google', 'browser_api_key');
        if ($browser !== '') return $browser;
    }
    return fm_provider_key_value('google', 'shared_api_key');
}

function fm_gemini_provider_key() {
    return fm_provider_key_value('gemini', 'api_key');
}

function fm_azure_maps_provider_key() {
    return fm_provider_key_value('azure', 'maps_subscription_key');
}
