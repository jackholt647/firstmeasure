<?php
/**
 * Fetching a URL a person supplied (docs/architecture/request-security.md#fetching-urls),
 * the PHP counterpart of public/v1/platform/security/safe-fetch.ts:
 * - http or https on port 80 or 443 only, no credentials in the URL;
 * - the host is resolved once and every address must be public (no private,
 *   loopback, link-local, metadata, CGNAT, multicast or reserved range, IPv4
 *   or IPv6, including IPv4-mapped and other embedded forms); the connection
 *   is pinned to the checked address with CURLOPT_RESOLVE;
 * - redirects are followed by hand, each target checked the same way, at most 3;
 * - a size and time limit, and an optional content-type check.
 */

if (realpath((string)($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    http_response_code(404);
    exit;
}

if (!function_exists('fm_safe_fetch')) {

function fm_ip_in_cidr(string $ip, string $cidr): bool
{
    [$subnet, $bits] = explode('/', $cidr, 2);
    $ipBin = @inet_pton($ip);
    $subnetBin = @inet_pton($subnet);
    if ($ipBin === false || $subnetBin === false || strlen($ipBin) !== strlen($subnetBin)) return false;
    $bits = (int)$bits;
    $bytes = intdiv($bits, 8);
    if ($bytes > 0 && substr($ipBin, 0, $bytes) !== substr($subnetBin, 0, $bytes)) return false;
    $rest = $bits % 8;
    if ($rest === 0) return true;
    $mask = (0xff << (8 - $rest)) & 0xff;
    return (ord($ipBin[$bytes]) & $mask) === (ord($subnetBin[$bytes]) & $mask);
}

/** Whether a literal IPv4 or IPv6 address is a public unicast address. */
function fm_ip_is_public(string $ip): bool
{
    $ip = trim($ip, '[]');
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        foreach ([
            '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
            '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
            '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
        ] as $cidr) {
            if (fm_ip_in_cidr($ip, $cidr)) return false;
        }
        return true;
    }
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
        // Only global unicast (2000::/3) can be public. That excludes ::, ::1,
        // IPv4-mapped/compatible (::ffff:0:0/96, ::/96), NAT64 (64:ff9b::/96),
        // ULA (fc00::/7, incl. cloud metadata fd00:ec2::254), link-local
        // (fe80::/10), site-local and multicast (ff00::/8).
        if (!fm_ip_in_cidr($ip, '2000::/3')) return false;
        // Inside it: Teredo and IETF protocol space, documentation, 6to4 (embeds IPv4).
        foreach (['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'] as $cidr) {
            if (fm_ip_in_cidr($ip, $cidr)) return false;
        }
        return true;
    }
    return false;
}

/**
 * The checked addresses for a URL's host: ['ok' => true, 'ips' => [...]] when
 * every address it resolves to is public, else ['ok' => false, 'error' => ...].
 */
function fm_safe_fetch_resolve(string $host): array
{
    $host = strtolower(rtrim($host, '.'));
    if ($host === '') return ['ok' => false, 'error' => 'missing_host'];
    $literal = trim($host, '[]');
    if (filter_var($literal, FILTER_VALIDATE_IP)) {
        return fm_ip_is_public($literal) ? ['ok' => true, 'ips' => [$literal]] : ['ok' => false, 'error' => 'blocked_address'];
    }
    // Numeric shorthands ("2130706433", "0x7f.1", "127.1") are not hostnames.
    if (preg_match('/^[0-9.]+$/', $host) || preg_match('/^0x/i', $host) || preg_match('/(^|\.)0x[0-9a-f]+(\.|$)/i', $host)) {
        return ['ok' => false, 'error' => 'blocked_address'];
    }
    if (!preg_match('/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/', $host)) {
        return ['ok' => false, 'error' => 'invalid_host'];
    }
    if ($host === 'localhost' || substr($host, -10) === '.localhost' || substr($host, -9) === '.internal' || substr($host, -6) === '.local') {
        return ['ok' => false, 'error' => 'blocked_address'];
    }
    $ips = [];
    $records = @dns_get_record($host, DNS_A | DNS_AAAA);
    if (is_array($records)) {
        foreach ($records as $record) {
            if (!empty($record['ip'])) $ips[] = (string)$record['ip'];
            if (!empty($record['ipv6'])) $ips[] = (string)$record['ipv6'];
        }
    }
    if (!$ips) {
        $v4 = @gethostbynamel($host);
        if (is_array($v4)) $ips = $v4;
    }
    $ips = array_values(array_unique($ips));
    if (!$ips) return ['ok' => false, 'error' => 'unresolved_host'];
    foreach ($ips as $ip) {
        if (!fm_ip_is_public($ip)) return ['ok' => false, 'error' => 'blocked_address'];
    }
    // Prefer IPv4 for the pinned connection.
    usort($ips, fn($a, $b) => (strpos($a, ':') !== false) <=> (strpos($b, ':') !== false));
    return ['ok' => true, 'ips' => $ips];
}

/** Parse and check one URL. Returns ['ok', 'url', 'host', 'port', 'ip'] or ['ok' => false, 'error']. */
function fm_safe_fetch_target(string $url): array
{
    if (strlen($url) > 4096 || preg_match('/[\x00-\x20\x7f\\\\]/', $url)) return ['ok' => false, 'error' => 'invalid_url'];
    $parts = parse_url($url);
    if (!is_array($parts)) return ['ok' => false, 'error' => 'invalid_url'];
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    if ($scheme !== 'http' && $scheme !== 'https') return ['ok' => false, 'error' => 'scheme_not_allowed'];
    if (isset($parts['user']) || isset($parts['pass'])) return ['ok' => false, 'error' => 'credentials_not_allowed'];
    $host = (string)($parts['host'] ?? '');
    $port = isset($parts['port']) ? (int)$parts['port'] : ($scheme === 'https' ? 443 : 80);
    if ($port !== 80 && $port !== 443) return ['ok' => false, 'error' => 'port_not_allowed'];
    $resolved = fm_safe_fetch_resolve($host);
    if (!$resolved['ok']) return $resolved;
    return ['ok' => true, 'url' => $url, 'host' => trim(strtolower($host), '[]'), 'port' => $port, 'ip' => $resolved['ips'][0]];
}

/** Resolve a redirect Location against the URL it came from. */
function fm_safe_fetch_join(string $base, string $location): string
{
    if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $location)) return $location;
    $parts = parse_url($base);
    $origin = strtolower((string)$parts['scheme']) . '://' . (string)$parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
    if (strpos($location, '//') === 0) return strtolower((string)$parts['scheme']) . ':' . $location;
    if (strpos($location, '/') === 0) return $origin . $location;
    $path = (string)($parts['path'] ?? '/');
    $dir = preg_replace('#/[^/]*$#', '/', $path);
    return $origin . ($dir === '' ? '/' : $dir) . $location;
}

/**
 * Fetch a URL a person supplied. Options: timeout (seconds, default 6),
 * max_bytes (default 2 MB), accept (Accept header), content_types (list of
 * allowed type prefixes, e.g. ['image/']), max_redirects (default 3, at most 3).
 * Returns ['ok' => true, 'body', 'content_type', 'url'] or ['ok' => false, 'error'].
 */
function fm_safe_fetch(string $url, array $opts = []): array
{
    if (!function_exists('curl_init')) return ['ok' => false, 'error' => 'curl_missing'];
    $timeout = max(1, (int)($opts['timeout'] ?? 6));
    $maxBytes = max(1, (int)($opts['max_bytes'] ?? 2 * 1024 * 1024));
    $maxRedirects = min(3, max(0, (int)($opts['max_redirects'] ?? 3)));
    $types = array_values(array_filter((array)($opts['content_types'] ?? []), 'is_string'));
    $deadline = microtime(true) + $timeout;

    for ($hop = 0; $hop <= $maxRedirects; $hop++) {
        $target = fm_safe_fetch_target($url);
        if (!$target['ok']) return $target;
        $remaining = $deadline - microtime(true);
        if ($remaining <= 0) return ['ok' => false, 'error' => 'timeout'];

        $ip = strpos($target['ip'], ':') !== false ? '[' . $target['ip'] . ']' : $target['ip'];
        $body = '';
        $tooLarge = false;
        $headers = [];
        $ch = curl_init($target['url']);
        $options = [
            CURLOPT_RESOLVE => [$target['host'] . ':' . $target['port'] . ':' . $ip],
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROXY => '',
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_CONNECTTIMEOUT_MS => (int)min(3000, $remaining * 1000),
            CURLOPT_TIMEOUT_MS => (int)($remaining * 1000),
            CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; FirstMateFetch/1.0)',
            CURLOPT_HTTPHEADER => ['Accept: ' . (string)($opts['accept'] ?? '*/*')],
            CURLOPT_ENCODING => '',
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$headers) {
                if (preg_match('#^HTTP/\S+\s+\d+#', $line)) $headers = [];
                $pair = explode(':', $line, 2);
                if (count($pair) === 2) $headers[strtolower(trim($pair[0]))] = trim($pair[1]);
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$body, &$tooLarge, $maxBytes) {
                if (strlen($body) + strlen($chunk) > $maxBytes) { $tooLarge = true; return 0; }
                $body .= $chunk;
                return strlen($chunk);
            },
        ];
        if (defined('CURLOPT_PROTOCOLS')) $options[CURLOPT_PROTOCOLS] = CURLPROTO_HTTP | CURLPROTO_HTTPS;
        curl_setopt_array($ch, $options);
        curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $primary = (string)curl_getinfo($ch, CURLINFO_PRIMARY_IP);
        $errno = curl_errno($ch);
        curl_close($ch);

        if ($tooLarge) return ['ok' => false, 'error' => 'too_large'];
        // Belt and braces: the connection must have gone to the checked address.
        $connected = @inet_pton(trim($primary, '[]'));
        if ($primary !== '' && ($connected === false || $connected !== @inet_pton($target['ip']))) return ['ok' => false, 'error' => 'blocked_address'];
        if ($errno !== 0 || $status === 0) return ['ok' => false, 'error' => 'fetch_failed'];
        if ($status >= 300 && $status < 400 && isset($headers['location'])) {
            $url = fm_safe_fetch_join($target['url'], $headers['location']);
            continue;
        }
        if ($status < 200 || $status >= 300) return ['ok' => false, 'error' => 'http_' . $status];
        $contentType = strtolower(trim(explode(';', (string)($headers['content-type'] ?? ''))[0]));
        if ($types) {
            $allowed = false;
            foreach ($types as $prefix) {
                if ($contentType !== '' && strpos($contentType, strtolower($prefix)) === 0) { $allowed = true; break; }
            }
            if (!$allowed) return ['ok' => false, 'error' => 'content_type_not_allowed'];
        }
        if ($body === '') return ['ok' => false, 'error' => 'empty_response'];
        return ['ok' => true, 'body' => $body, 'content_type' => $contentType, 'url' => $target['url']];
    }
    return ['ok' => false, 'error' => 'too_many_redirects'];
}

}
