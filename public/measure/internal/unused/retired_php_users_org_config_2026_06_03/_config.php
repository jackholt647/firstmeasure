<?php
require_once __DIR__ . '/_storage.php';
/**
 * _config.php
 *
 * Global server configuration store.
 * Persists key-value settings in server_config.json with file locking.
 *
 * Include BEFORE other modules so they can read config values at load time.
 *
 * Functions:
 *   serverConfigRead()                   – returns full settings array
 *   serverConfigGet($key, $default)      – read one key
 *   serverConfigSet($key, $value)        – write one key (admin only in handlers)
 *   serverConfigSetMany($pairs)          – write multiple keys atomically
 *   serverConfigDelete($key)             – remove one key
 *   serverConfigPath()                   – path to the JSON file
 *
 * Action handlers (all admin-only):
 *   server_config_list                   – GET all settings
 *   server_config_get                    – GET one key
 *   server_config_set                    – SET one or many keys
 *   server_config_delete                 – DELETE one key
 */

// ------------------------------------------------
// --------------- FILE PATH & LOCK ---------------
// ------------------------------------------------

function serverConfigStorageDir() {
    $dir = storagePath('config');
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    return $dir;
}

function serverConfigLegacyPath() {
    $root = dirname(__DIR__, 3);
    return $root . '/private/measure_internal_config/server_config.json';
}

function serverConfigLegacyLockPath() {
    $root = dirname(__DIR__, 3);
    return $root . '/private/measure_internal_config/server_config.lock';
}

function serverConfigPath() {
    return serverConfigStorageDir() . '/server_config.json';
}

function serverConfigLockPath() {
    return serverConfigStorageDir() . '/server_config.lock';
}

function serverConfigMaybeMigrateLegacyFile() {
    static $didRun = false;
    if ($didRun) return;
    $didRun = true;

    $path = serverConfigPath();
    if (file_exists($path)) return;

    $legacyPath = serverConfigLegacyPath();
    if (!file_exists($legacyPath)) return;

    $legacyRaw = @file_get_contents($legacyPath);
    if ($legacyRaw === false || $legacyRaw === '') return;

    @file_put_contents($path, $legacyRaw);
}

/**
 * Execute $fn while holding an exclusive lock on the config file.
 * Prevents concurrent writes from corrupting the JSON.
 *
 * @param callable $fn
 * @return mixed Whatever $fn returns
 */
function withConfigLock($fn) {
    $lockFile = serverConfigLockPath();
    $fh = fopen($lockFile, 'c+');
    if (!$fh) return $fn();                     // degrade gracefully
    try {
        flock($fh, LOCK_EX);
        $out = $fn();
        flock($fh, LOCK_UN);
        fclose($fh);
        return $out;
    } catch (Exception $e) {
        try { flock($fh, LOCK_UN); fclose($fh); } catch (Exception $e2) {}
        return null;
    }
}

// ------------------------------------------------
// --------------- RAW READ / WRITE ---------------
// ------------------------------------------------

/**
 * Read the full config file and return the decoded structure.
 * Always returns ['_meta' => [...], 'settings' => [...]].
 */
function serverConfigReadRaw() {
    serverConfigMaybeMigrateLegacyFile();
    $path = serverConfigPath();

    if (!file_exists($path)) {
        return [
            '_meta' => [
                'created_at' => null,
                'updated_at' => null,
            ],
            'settings' => [],
        ];
    }

    $raw = @file_get_contents($path);
    $data = json_decode((string)$raw, true);

    if (!is_array($data)) {
        $data = [];
    }

    // Normalise shape
    if (!isset($data['_meta']) || !is_array($data['_meta'])) {
        $data['_meta'] = [];
    }
    if (!isset($data['settings']) || !is_array($data['settings'])) {
        $data['settings'] = [];
    }

    return $data;
}

/**
 * Write the full config structure to disk.
 * Caller must hold the config lock.
 *
 * @param array $data Full structure with _meta and settings
 * @return bool
 */
function serverConfigWriteRaw($data) {
    if (!is_array($data)) return false;

    $data['_meta']['updated_at'] = gmdate('c');
    if (empty($data['_meta']['created_at'])) {
        $data['_meta']['created_at'] = $data['_meta']['updated_at'];
    }

    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($json === false) return false;

    $path = serverConfigPath();
    return (@file_put_contents($path, $json) !== false);
}

// ------------------------------------------------
// --------------- PUBLIC HELPERS -----------------
// ------------------------------------------------

/**
 * Return all settings as an associative array (keys → values).
 */
function serverConfigRead() {
    $data = serverConfigReadRaw();
    return $data['settings'];
}

/**
 * Get a single config value.
 *
 * @param string $key     Dot-notation NOT supported; flat keys only.
 * @param mixed  $default Returned when key does not exist.
 * @return mixed
 */
function serverConfigGet($key, $default = null) {
    $settings = serverConfigRead();
    return array_key_exists($key, $settings) ? $settings[$key] : $default;
}

/**
 * Set a single config key.
 * Thread-safe (acquires file lock).
 *
 * @param string $key
 * @param mixed  $value  Must be JSON-serialisable.
 * @return bool
 */
function serverConfigSet($key, $value) {
    $key = trim((string)$key);
    if ($key === '' || $key === '_meta') return false;

    return (bool)withConfigLock(function () use ($key, $value) {
        $data = serverConfigReadRaw();
        $data['settings'][$key] = $value;
        return serverConfigWriteRaw($data);
    });
}

/**
 * Set many keys atomically.
 *
 * @param array $pairs ['key' => value, ...]
 * @return bool
 */
function serverConfigSetMany(array $pairs) {
    if (empty($pairs)) return true;

    return (bool)withConfigLock(function () use ($pairs) {
        $data = serverConfigReadRaw();
        foreach ($pairs as $k => $v) {
            $k = trim((string)$k);
            if ($k === '' || $k === '_meta') continue;
            $data['settings'][$k] = $v;
        }
        return serverConfigWriteRaw($data);
    });
}

/**
 * Remove a key from config.
 *
 * @param string $key
 * @return bool
 */
function serverConfigDelete($key) {
    $key = trim((string)$key);
    if ($key === '' || $key === '_meta') return false;

    return (bool)withConfigLock(function () use ($key) {
        $data = serverConfigReadRaw();
        if (!array_key_exists($key, $data['settings'])) return true; // already gone
        unset($data['settings'][$key]);
        return serverConfigWriteRaw($data);
    });
}

// ------------------------------------------------
// --------------- ACTION HANDLERS ----------------
// ------------------------------------------------

/**
 * Handle server_config_* actions.
 * Returns true if the action was handled, false otherwise.
 */
function handleConfigActions($action) {

    // ----- LIST all settings -----
    if ($action === 'server_config_list') {
        if (!isAdmin()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }

        $data = serverConfigReadRaw();
        echo json_encode([
            'success'  => true,
            'settings' => $data['settings'],
            '_meta'    => $data['_meta'],
        ]);
        return true;
    }

    // ----- GET one key -----
    if ($action === 'server_config_get') {
        if (!isAdmin()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }

        $key = trim((string)($_POST['key'] ?? ''));
        if ($key === '') {
            echo json_encode(['success' => false, 'error' => 'Missing key']);
            return true;
        }

        $settings = serverConfigRead();
        $exists = array_key_exists($key, $settings);

        echo json_encode([
            'success' => true,
            'key'     => $key,
            'exists'  => $exists,
            'value'   => $exists ? $settings[$key] : null,
        ]);
        return true;
    }

    // ----- SET one or many keys -----
    // POST: key + value   (single)
    //   OR: pairs (JSON object)  (batch)
    if ($action === 'server_config_set') {
        if (!isAdmin()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }

        // Batch mode
        $rawPairs = $_POST['pairs'] ?? null;
        if ($rawPairs !== null) {
            $pairs = json_decode((string)$rawPairs, true);
            if (!is_array($pairs) || empty($pairs)) {
                echo json_encode(['success' => false, 'error' => 'Invalid pairs JSON']);
                return true;
            }
            $ok = serverConfigSetMany($pairs);
            echo json_encode(['success' => $ok, 'keys_set' => array_keys($pairs)]);
            return true;
        }

        // Single mode
        $key = trim((string)($_POST['key'] ?? ''));
        if ($key === '') {
            echo json_encode(['success' => false, 'error' => 'Missing key']);
            return true;
        }

        // Accept value as raw JSON so callers can store objects/arrays/numbers
        $rawValue = $_POST['value'] ?? '';
        $value = json_decode((string)$rawValue, true);
        if ($value === null && strtolower(trim((string)$rawValue)) !== 'null') {
            // Not valid JSON – treat as plain string
            $value = (string)$rawValue;
        }

        $ok = serverConfigSet($key, $value);
        echo json_encode(['success' => $ok, 'key' => $key]);
        return true;
    }

    // ----- DELETE one key -----
    if ($action === 'server_config_delete') {
        if (!isAdmin()) {
            echo json_encode(['success' => false, 'error' => 'Unauthorized']);
            return true;
        }

        $key = trim((string)($_POST['key'] ?? ''));
        if ($key === '') {
            echo json_encode(['success' => false, 'error' => 'Missing key']);
            return true;
        }

        $ok = serverConfigDelete($key);
        echo json_encode(['success' => $ok, 'key' => $key]);
        return true;
    }

    return false;   // not handled
}
