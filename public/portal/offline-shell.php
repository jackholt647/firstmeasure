<?php
// Headers the offline service worker reads from a portal page (docs/architecture/offline.md, "Serving").
//
// X-FirstMate-Release   the release this page was rendered from: the name the offline asset manifest reports
//                       (servedRelease() in v1/platform/live_assets.ts, the directory the current-release
//                       link points at). Not sent where there is no release directory (a local checkout).
// X-FirstMate-Identity  whose page this is, "<user id>/<organization id>" (each URL-encoded), so the worker
//                       stores it as that person's shell and nobody else's. Only a signed-in portal page
//                       sends it; a login redirect or an error page never does.

function portalServedRelease(): string
{
    $link = trim((string)(getenv('FIRSTMEASURE_CURRENT_RELEASE_LINK') ?: '/opt/firstmeasure/current'));
    if ($link === '') {
        return '';
    }
    // The link moves at every release; PHP remembers resolved paths for two minutes.
    clearstatcache(true, $link);
    $current = @realpath($link);
    if (!is_string($current) || $current === '') {
        return '';
    }
    // While a release is being switched a request can still be rendered by the previous one. Name the release
    // this file belongs to, so a page is never stored as the shell of a set it does not match.
    $releases = dirname($current) . DIRECTORY_SEPARATOR;
    if (strpos(__DIR__, $releases) === 0 && strpos(__DIR__, $current . DIRECTORY_SEPARATOR) !== 0) {
        $own = strtok(substr(__DIR__, strlen($releases)), DIRECTORY_SEPARATOR);
        if (is_string($own) && $own !== '') {
            return $own;
        }
    }
    return basename($current);
}

function portalOfflineShellHeaders($userId, $orgId): void
{
    if (headers_sent()) {
        return;
    }
    $release = preg_replace('/[^A-Za-z0-9._-]/', '', portalServedRelease());
    if ($release !== '') {
        header('X-FirstMate-Release: ' . $release);
    }
    $userId = trim((string)$userId);
    $orgId = trim((string)$orgId);
    if ($userId !== '' && $orgId !== '') {
        header('X-FirstMate-Identity: ' . rawurlencode($userId) . '/' . rawurlencode($orgId));
    }
}
