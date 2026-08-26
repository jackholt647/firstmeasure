<?php
/*
 * image_proxy.php
 * ─────────────────────────────────────────────────────────────
 * Standalone proxy for the onboarding wizard.
 * Drop in the same folder as server.php / index.php.
 *
 * Two actions:
 *   action=scrape_logos&url=https://example.com
 *     → Fetches the page HTML, finds logo candidates via:
 *       JSON-LD Organization.logo, <link rel="preload" as="image">,
 *       manifest.json icons, structural <header>/<nav> images,
 *       inline SVG sprites, <link rel="icon">, <img> tag heuristics,
 *       og:image, and common fallback paths.
 *       Returns candidates sorted by relevance score.
 *
 *   action=fetch_image&url=https://example.com/logo.png
 *     → Fetches the image bytes, returns a base64 data URL
 *       so the client canvas can read pixels without CORS.
 * ─────────────────────────────────────────────────────────────
 */

require_once __DIR__ . '/session_bootstrap.php';
portalStartSession();

header('Content-Type: application/json');

// Must be logged in
if (empty($_SESSION['user_email'])) {
    http_response_code(401);
    die(json_encode(['success' => false, 'error' => 'Not authenticated']));
}

$action = trim($_POST['action'] ?? $_GET['action'] ?? '');
$url    = trim($_POST['url']    ?? $_GET['url']    ?? '');

if ($url === '' || !preg_match('#^https?://#i', $url)) {
    die(json_encode(['success' => false, 'error' => 'Invalid or missing URL']));
}

// Shared fetch helper
function proxyFetch(string $url, int $timeout = 6, int $maxBytes = 2 * 1024 * 1024): ?string {
    $ctx = stream_context_create([
        'http' => [
            'timeout'        => $timeout,
            'max_redirects'  => 5,
            'follow_location'=> 1,
            'user_agent'     => 'Mozilla/5.0 (compatible; LogoFetch/1.0)',
            'ignore_errors'  => true,
            'header'         => "Accept: */*\r\n",
        ],
        'ssl' => [
            'verify_peer'      => false,
            'verify_peer_name' => false,
        ],
    ]);

    $bytes = @file_get_contents($url, false, $ctx, 0, $maxBytes + 1);
    if ($bytes === false || strlen($bytes) === 0) return null;
    if (strlen($bytes) > $maxBytes) return null;
    return $bytes;
}


// ═══════════════════════════════════════════════════════════════
//  ACTION: scrape_logos
// ═══════════════════════════════════════════════════════════════
if ($action === 'scrape_logos') {

    $html = proxyFetch($url, 8, 512 * 1024);
    if (!$html) {
        die(json_encode(['success' => false, 'error' => 'Could not fetch page']));
    }

    $parsed = parse_url($url);
    $origin = ($parsed['scheme'] ?? 'https') . '://' . ($parsed['host'] ?? '');
    $base = $url;

    if (preg_match('#<base\s[^>]*href\s*=\s*["\']([^"\']+)["\']#i', $html, $bm)) {
        $base = $bm[1];
    }

    $candidates = [];

    // ── Resolve relative URLs ──
    $resolve = function(string $href) use ($base, $url, $origin) {
        $href = trim($href);
        if ($href === '') return '';
        if (str_starts_with($href, 'data:')) return $href; // Pass data: URLs through
        if (preg_match('#^https?://#i', $href)) return $href;
        if (str_starts_with($href, '//')) return 'https:' . $href;
        if (str_starts_with($href, '/')) return $origin . $href;
        $dir = preg_replace('#/[^/]*$#', '/', $base);
        return $dir . $href;
    };

    // ── Score a string for logo-like keywords ──
    $scoreName = function(string $str): int {
        $str = strtolower($str);
        $s = 0;
        if (strpos($str, 'logo') !== false)          $s += 100;
        if (strpos($str, 'brand') !== false)          $s += 60;
        if (strpos($str, 'header-logo') !== false)    $s += 40;
        if (strpos($str, 'site-logo') !== false)      $s += 40;
        if (strpos($str, 'navbar') !== false)          $s += 20;
        if (strpos($str, 'header') !== false)          $s += 15;
        if (strpos($str, 'icon') !== false)            $s += 10;
        if (strpos($str, 'apple-touch') !== false)     $s += 30;
        if (strpos($str, 'favicon') !== false)         $s += 5;
        if (strpos($str, 'avatar') !== false)          $s -= 50;
        if (strpos($str, 'photo') !== false)           $s -= 30;
        if (strpos($str, 'banner') !== false)          $s -= 20;
        if (strpos($str, 'background') !== false)      $s -= 20;
        if (strpos($str, 'hero') !== false)            $s -= 20;
        if (strpos($str, 'screenshot') !== false)      $s -= 30;
        if (strpos($str, 'gallery') !== false)         $s -= 20;
        if (strpos($str, 'thumbnail') !== false)       $s -= 15;
        if (strpos($str, 'badge') !== false)           $s -= 10;
        if (strpos($str, 'award') !== false)           $s -= 10;
        if (strpos($str, 'cert') !== false)            $s -= 10;
        return $s;
    };

    $seen = [];
    $addCandidate = function(string $href, int $baseScore, string $source) use (&$candidates, &$seen, $resolve) {
        $resolved = $resolve($href);
        if ($resolved === '') return;
        $key = strtolower($resolved);
        if (isset($seen[$key])) {
            // Boost existing candidate if found via multiple signals
            foreach ($candidates as &$c) {
                if (strtolower($c['url']) === $key) {
                    $c['score'] = max($c['score'], $baseScore);
                    break;
                }
            }
            return;
        }
        $seen[$key] = true;
        $candidates[] = ['url' => $resolved, 'score' => $baseScore, 'source' => $source];
    };


    // ─── 1) JSON-LD structured data (highest confidence) ──────────
    // Sites explicitly declare their logo in Organization schema.
    if (preg_match_all('#<script\s[^>]*type\s*=\s*["\']application/ld\+json["\'][^>]*>(.*?)</script>#si', $html, $ldMatches)) {
        foreach ($ldMatches[1] as $jsonStr) {
            $ld = @json_decode($jsonStr, true);
            if (!$ld) continue;

            $objects = isset($ld['@type']) ? [$ld] : (is_array($ld) ? $ld : []);
            if (isset($ld['@graph']) && is_array($ld['@graph'])) {
                $objects = array_merge($objects, $ld['@graph']);
            }

            foreach ($objects as $obj) {
                if (!is_array($obj)) continue;
                if (!empty($obj['logo'])) {
                    $logoVal = $obj['logo'];
                    if (is_string($logoVal)) {
                        $addCandidate($logoVal, 500, 'json-ld');
                    } elseif (is_array($logoVal) && !empty($logoVal['url'])) {
                        $addCandidate($logoVal['url'], 500, 'json-ld');
                    }
                }
                $type = $obj['@type'] ?? '';
                if (in_array($type, ['Organization', 'LocalBusiness', 'Corporation', 'WebSite'])) {
                    if (!empty($obj['image'])) {
                        $imgVal = is_string($obj['image']) ? $obj['image'] : ($obj['image']['url'] ?? '');
                        if ($imgVal) $addCandidate($imgVal, 200, 'json-ld-image');
                    }
                }
            }
        }
    }


    // ─── 2) <link> tags: preload, icons, manifest ─────────────────
    if (preg_match_all('#<link\s[^>]*>#i', $html, $allLinks)) {
        foreach ($allLinks[0] as $tag) {
            $rel = '';
            if (preg_match('#rel\s*=\s*["\']([^"\']+)["\']#i', $tag, $rm)) $rel = strtolower($rm[1]);
            $as = '';
            if (preg_match('#\bas\s*=\s*["\']([^"\']+)["\']#i', $tag, $am)) $as = strtolower($am[1]);
            $href = '';
            if (preg_match('#href\s*=\s*["\']([^"\']+)["\']#i', $tag, $hm)) $href = $hm[1];
            if ($href === '') continue;

            // Preloaded images — very likely the logo
            if ($rel === 'preload' && $as === 'image') {
                $addCandidate($href, 250 + $scoreName($href), 'preload');
            }

            // Apple touch icons
            if (strpos($rel, 'apple-touch-icon') !== false) {
                $addCandidate($href, 180 + $scoreName($href), 'apple-touch-icon');
            }

            // Other icons
            elseif (strpos($rel, 'icon') !== false) {
                $sizeBonus = 0;
                if (preg_match('#sizes\s*=\s*["\'](\d+)x\d+["\']#i', $tag, $sm)) {
                    $sizeBonus = min(50, intval($sm[1]) / 4);
                }
                $addCandidate($href, 80 + $sizeBonus + $scoreName($href), 'link-icon');
            }

            // Manifest — fetch and parse for icons
            if ($rel === 'manifest') {
                $manifestUrl = $resolve($href);
                if ($manifestUrl) {
                    $manifestJson = proxyFetch($manifestUrl, 4, 64 * 1024);
                    if ($manifestJson) {
                        $manifest = @json_decode($manifestJson, true);
                        if ($manifest && !empty($manifest['icons']) && is_array($manifest['icons'])) {
                            usort($manifest['icons'], function($a, $b) {
                                return intval($b['sizes'] ?? '0') - intval($a['sizes'] ?? '0');
                            });
                            foreach ($manifest['icons'] as $mIcon) {
                                if (!empty($mIcon['src'])) {
                                    $mSrc = $mIcon['src'];
                                    if (!preg_match('#^https?://#i', $mSrc) && !str_starts_with($mSrc, '/')) {
                                        $mDir = preg_replace('#/[^/]*$#', '/', $manifestUrl);
                                        $mSrc = $mDir . $mSrc;
                                    } elseif (str_starts_with($mSrc, '/')) {
                                        $mSrc = $origin . $mSrc;
                                    }
                                    $sizeVal = intval($mIcon['sizes'] ?? '0');
                                    $addCandidate($mSrc, 150 + min(80, $sizeVal / 4), 'manifest');
                                }
                            }
                        }
                    }
                }
            }
        }
    }


    // ─── 3) Images inside <header> or <nav> (structural) ─────────
    foreach (['header', 'nav'] as $containerTag) {
        if (preg_match('#<' . $containerTag . '[\s>].*?</' . $containerTag . '>#si', $html, $containerMatch)) {
            $containerHtml = $containerMatch[0];

            // ── 3a) <img> tags in header/nav ──
            if (preg_match_all('#<img\s[^>]*>#i', $containerHtml, $containerImgs)) {
                $isFirst = true;
                foreach ($containerImgs[0] as $tag) {
                    $src = '';
                    if (preg_match('#src\s*=\s*["\']([^"\']+)["\']#i', $tag, $sm)) $src = $sm[1];
                    if ($src === '') continue;

                    $alt = ''; $class = ''; $id = '';
                    if (preg_match('#alt\s*=\s*["\']([^"\']*)["\']#i', $tag, $am))   $alt   = $am[1];
                    if (preg_match('#class\s*=\s*["\']([^"\']*)["\']#i', $tag, $cm)) $class = $cm[1];
                    if (preg_match('#id\s*=\s*["\']([^"\']*)["\']#i', $tag, $im))    $id    = $im[1];

                    $textScore = $scoreName($src) + $scoreName($alt) + $scoreName($class) + $scoreName($id);
                    $positionScore = $isFirst ? 200 : 120;
                    $addCandidate($src, $positionScore + $textScore, $containerTag . '-img');
                    $isFirst = false;
                }
            }

            // ── Helper: resolve a <use href="#id"> by finding the <symbol> in the full HTML ──
            // The sprite SVG block may be nested (e.g. <svg style="display:none"><symbol>...</symbol></svg>)
            // so we use a greedy regex on the full HTML to find the symbol by its id attribute.
            // Returns a standalone SVG string or null on failure.
            $resolveSymbol = function(string $symbolId) use ($html): ?string {
                // Match <symbol id="symbolId" ...>CONTENT</symbol>
                // Use greedy match for content since symbols can be large and contain nested elements
                $escaped = preg_quote($symbolId, '#');
                // Try greedy first (handles large symbols), then lazy as fallback
                $found = false;
                if (preg_match('#<symbol\s[^>]*id\s*=\s*["\']' . $escaped . '["\'][^>]*>(.*)</symbol>#siU', $html, $symMatch)) {
                    $found = true;
                }
                if (!$found) {
                    // Fallback: match across lines with dotall
                    if (preg_match('#<symbol\s[^>]*id\s*=\s*["\']' . $escaped . '["\'][^>]*>([\s\S]*?)</symbol>#i', $html, $symMatch)) {
                        $found = true;
                    }
                }
                if (!$found) return null;

                $innerSvg = trim($symMatch[1]);
                if ($innerSvg === '') return null;

                // Grab viewBox from the <symbol> tag
                $viewBox = '';
                if (preg_match('#viewBox\s*=\s*["\']([^"\']+)["\']#i', $symMatch[0], $vbm)) {
                    $viewBox = ' viewBox="' . htmlspecialchars($vbm[1], ENT_QUOTES) . '"';
                }

                // Also grab fill if specified on the symbol
                $fill = '';
                if (preg_match('#\bfill\s*=\s*["\']([^"\']+)["\']#i', $symMatch[0], $fm)) {
                    $fill = ' fill="' . htmlspecialchars($fm[1], ENT_QUOTES) . '"';
                }

                return '<svg xmlns="http://www.w3.org/2000/svg"' . $viewBox . $fill . '>' . $innerSvg . '</svg>';
            };

            // ── Helper: check if an SVG string has unresolved <use> references ──
            $hasUnresolvedUse = function(string $svg): bool {
                return (bool) preg_match('#<use\s[^>]*(?:xlink:)?href\s*=\s*["\']#[^"\']+["\']#i', $svg);
            };

            // ── 3b) Inline SVG logos in header/nav ──
            // Detect <svg> elements inside logo-like wrappers (<a>, <div>, <span>)
            // that use <use href="#id"> to reference an SVG sprite symbol,
            // or contain inline SVG paths directly.
            if (preg_match_all('#<(?:a|div|span)\s([^>]*)>(\s*<svg[\s>].*?</svg>\s*)</(?:a|div|span)>#si', $containerHtml, $svgWrappers, PREG_SET_ORDER)) {
                foreach ($svgWrappers as $wrapper) {
                    $wrapperAttrs = $wrapper[1];
                    $svgBlock     = $wrapper[2];

                    // Check if the wrapper has logo-like class/id/aria-label
                    $isLogo = false;
                    if (preg_match_all('#(?:class|id|aria-label)\s*=\s*["\']([^"\']*)["\']#i', $wrapperAttrs, $attrMatches, PREG_SET_ORDER)) {
                        foreach ($attrMatches as $attrMatch) {
                            if (stripos($attrMatch[1], 'logo') !== false) {
                                $isLogo = true;
                                break;
                            }
                        }
                    }

                    // Also check <title> inside the SVG
                    if (!$isLogo && preg_match('#<title>([^<]*)</title>#i', $svgBlock, $titleMatch)) {
                        if (stripos($titleMatch[1], 'logo') !== false) {
                            $isLogo = true;
                        }
                    }

                    if (!$isLogo) continue;

                    // Case A: <use href="#symbol-id"> or <use xlink:href="#symbol-id">
                    //         Resolve the sprite symbol from elsewhere in the page
                    if (preg_match('#<use\s[^>]*(?:xlink:)?href\s*=\s*["\']#([^"\']+)["\']#i', $svgBlock, $useMatch)) {
                        $symbolId = $useMatch[1];
                        $resolved = $resolveSymbol($symbolId);
                        if ($resolved !== null) {
                            $dataUrl = 'data:image/svg+xml;base64,' . base64_encode($resolved);
                            $addCandidate($dataUrl, 400, 'inline-svg-sprite');
                        }
                        // If resolution failed, do NOT add the raw SVG — it would render blank
                        continue;
                    }

                    // Case B: SVG with inline paths (no <use>), already self-contained
                    // Only match if it has actual drawing content
                    if (preg_match('#(<svg[\s>].*?</svg>)#si', $svgBlock, $rawSvgMatch)) {
                        $rawSvg = $rawSvgMatch[1];

                        // GUARD: never output SVGs with unresolved <use> references
                        if ($hasUnresolvedUse($rawSvg)) continue;

                        // Skip tiny utility SVGs (hamburger menus, close buttons, etc.)
                        // by requiring the SVG to have a <title> with "logo" or substantial path data
                        $hasLogoTitle = preg_match('#<title>[^<]*logo[^<]*</title>#i', $rawSvg);
                        $pathDataLen = 0;
                        if (preg_match_all('#\bd\s*=\s*["\']([^"\']+)["\']#i', $rawSvg, $pathDs)) {
                            foreach ($pathDs[1] as $d) $pathDataLen += strlen($d);
                        }

                        // Only treat as a logo if it has a logo title or substantial path data (>200 chars)
                        if ($hasLogoTitle || $pathDataLen > 200) {
                            // Ensure xmlns is present
                            if (stripos($rawSvg, 'xmlns') === false) {
                                $rawSvg = preg_replace('#<svg#i', '<svg xmlns="http://www.w3.org/2000/svg"', $rawSvg, 1);
                            }
                            $dataUrl = 'data:image/svg+xml;base64,' . base64_encode($rawSvg);
                            $addCandidate($dataUrl, 380, 'inline-svg');
                        }
                    }
                }
            }

            // ── 3c) Standalone <svg> directly in header/nav (not inside a wrapper) ──
            // Some sites put the logo SVG directly in the header without a wrapper element
            if (preg_match_all('#<svg[\s>].*?</svg>#si', $containerHtml, $standaloneSvgs)) {
                foreach ($standaloneSvgs[0] as $svgTag) {
                    // Must have a <title> containing "logo"
                    if (!preg_match('#<title>([^<]*)</title>#i', $svgTag, $titleMatch)) continue;
                    if (stripos($titleMatch[1], 'logo') === false) continue;

                    // Check for <use href="#..."> referencing a sprite
                    if (preg_match('#<use\s[^>]*(?:xlink:)?href\s*=\s*["\']#([^"\']+)["\']#i', $svgTag, $useMatch)) {
                        $symbolId = $useMatch[1];
                        $resolved = $resolveSymbol($symbolId);
                        if ($resolved !== null) {
                            $dataUrl = 'data:image/svg+xml;base64,' . base64_encode($resolved);
                            $addCandidate($dataUrl, 400, 'inline-svg-sprite');
                        }
                        // If resolution failed, do NOT add — it would render blank
                    } else {
                        // Self-contained SVG with logo title
                        $rawSvg = $svgTag;

                        // GUARD: never output SVGs with unresolved <use> references
                        if ($hasUnresolvedUse($rawSvg)) continue;

                        if (stripos($rawSvg, 'xmlns') === false) {
                            $rawSvg = preg_replace('#<svg#i', '<svg xmlns="http://www.w3.org/2000/svg"', $rawSvg, 1);
                        }
                        $dataUrl = 'data:image/svg+xml;base64,' . base64_encode($rawSvg);
                        $addCandidate($dataUrl, 380, 'inline-svg');
                    }
                }
            }
        }
    }


    // ─── 4) All <img> tags with logo signal ──────────────────────
    if (preg_match_all('#<img\s[^>]*>#i', $html, $imgMatches)) {
        foreach ($imgMatches[0] as $tag) {
            $src = '';
            if (preg_match('#src\s*=\s*["\']([^"\']+)["\']#i', $tag, $sm)) $src = $sm[1];
            if ($src === '') continue;

            $alt = ''; $class = ''; $id = '';
            if (preg_match('#alt\s*=\s*["\']([^"\']*)["\']#i', $tag, $am))   $alt   = $am[1];
            if (preg_match('#class\s*=\s*["\']([^"\']*)["\']#i', $tag, $cm)) $class = $cm[1];
            if (preg_match('#id\s*=\s*["\']([^"\']*)["\']#i', $tag, $im))    $id    = $im[1];

            $textScore = $scoreName($src) + $scoreName($alt) + $scoreName($class) + $scoreName($id);
            if ($textScore > 0) {
                $addCandidate($src, $textScore, 'img');
            }
        }
    }


    // ─── 5) <img> tags with srcset (responsive images) ───────────
    if (preg_match_all('#<img\s[^>]*srcset\s*=\s*["\']([^"\']+)["\'][^>]*>#i', $html, $srcsetMatches, PREG_SET_ORDER)) {
        foreach ($srcsetMatches as $match) {
            $tag = $match[0];
            $srcsetVal = $match[1];

            $alt = ''; $class = ''; $id = '';
            if (preg_match('#alt\s*=\s*["\']([^"\']*)["\']#i', $tag, $am))   $alt   = $am[1];
            if (preg_match('#class\s*=\s*["\']([^"\']*)["\']#i', $tag, $cm)) $class = $cm[1];
            if (preg_match('#id\s*=\s*["\']([^"\']*)["\']#i', $tag, $im))    $id    = $im[1];

            $textScore = $scoreName($srcsetVal) + $scoreName($alt) + $scoreName($class) + $scoreName($id);

            // Parse srcset: "url1 1x, url2 2x" or "url1 300w, url2 600w"
            $entries = preg_split('#\s*,\s*#', $srcsetVal);
            $bestUrl = '';
            $bestDescriptor = 0;
            foreach ($entries as $entry) {
                $parts = preg_split('#\s+#', trim($entry));
                $entryUrl = $parts[0] ?? '';
                $descriptor = $parts[1] ?? '1x';
                $descVal = floatval($descriptor);
                if ($descVal > $bestDescriptor) {
                    $bestDescriptor = $descVal;
                    $bestUrl = $entryUrl;
                }
            }
            if ($bestUrl && $textScore > 0) {
                $addCandidate($bestUrl, $textScore, 'img-srcset');
            }
        }
    }


    // ─── 6) <source> inside <picture> elements ───────────────────
    if (preg_match_all('#<picture[^>]*>(.*?)</picture>#si', $html, $pictureMatches)) {
        foreach ($pictureMatches[1] as $pictureInner) {
            // Get context from the fallback <img> inside <picture>
            $alt = ''; $class = ''; $id = '';
            if (preg_match('#<img\s[^>]*>#i', $pictureInner, $imgTag)) {
                if (preg_match('#alt\s*=\s*["\']([^"\']*)["\']#i', $imgTag[0], $am))   $alt   = $am[1];
                if (preg_match('#class\s*=\s*["\']([^"\']*)["\']#i', $imgTag[0], $cm)) $class = $cm[1];
                if (preg_match('#id\s*=\s*["\']([^"\']*)["\']#i', $imgTag[0], $im))    $id    = $im[1];
            }

            if (preg_match_all('#<source\s[^>]*>#i', $pictureInner, $sourceMatches)) {
                foreach ($sourceMatches[0] as $sourceTag) {
                    $srcset = '';
                    if (preg_match('#srcset\s*=\s*["\']([^"\']+)["\']#i', $sourceTag, $ssm)) {
                        $srcset = $ssm[1];
                    }
                    if ($srcset === '') continue;

                    $textScore = $scoreName($srcset) + $scoreName($alt) + $scoreName($class) + $scoreName($id);
                    if ($textScore > 0) {
                        // Take the first URL from srcset
                        $firstUrl = preg_split('#\s+#', trim(explode(',', $srcset)[0]))[0] ?? '';
                        if ($firstUrl) {
                            $addCandidate($firstUrl, $textScore, 'picture-source');
                        }
                    }
                }
            }
        }
    }


    // ─── 7) CSS background-image in inline styles ────────────────
    if (preg_match_all('#style\s*=\s*["\']([^"\']*background[^"\']*)["\']#i', $html, $styleMatches)) {
        foreach ($styleMatches[1] as $styleVal) {
            if (preg_match('#background(?:-image)?\s*:\s*[^;]*url\(\s*["\']?([^"\')\s]+)["\']?\s*\)#i', $styleVal, $bgm)) {
                $bgUrl = $bgm[1];
                $textScore = $scoreName($bgUrl);
                if ($textScore > 0) {
                    $addCandidate($bgUrl, $textScore, 'bg-image');
                }
            }
        }
    }


    // ─── 8) Open Graph image (moderate signal) ───────────────────
    if (preg_match('#<meta\s[^>]*property\s*=\s*["\']og:image["\'][^>]*content\s*=\s*["\']([^"\']+)["\']#i', $html, $ogm)) {
        $addCandidate($ogm[1], 25, 'og:image');
    } elseif (preg_match('#<meta\s[^>]*content\s*=\s*["\']([^"\']+)["\'][^>]*property\s*=\s*["\']og:image["\']#i', $html, $ogm)) {
        $addCandidate($ogm[1], 25, 'og:image');
    }


    // ─── 9) Fallback: common hardcoded paths ─────────────────────
    $fallbacks = ['/apple-touch-icon.png', '/logo.png', '/favicon-32x32.png', '/favicon.png', '/favicon.ico'];
    foreach ($fallbacks as $fb) {
        $addCandidate($origin . $fb, 5, 'fallback');
    }


    // Sort by score descending
    usort($candidates, function($a, $b) { return $b['score'] - $a['score']; });

    // Return top 20 candidates with scores so JS can use them as tiebreakers
    $results = array_values(array_map(
        function($c) { return ['url' => $c['url'], 'score' => $c['score'], 'source' => $c['source']]; },
        array_slice($candidates, 0, 20)
    ));

    echo json_encode([
        'success'    => true,
        'candidates' => $results,
    ]);
    exit;
}


// ═══════════════════════════════════════════════════════════════
//  ACTION: fetch_image
// ═══════════════════════════════════════════════════════════════
if ($action === 'fetch_image') {

    // Data URLs (from inline SVG detection) can be returned directly
    if (str_starts_with($url, 'data:')) {
        echo json_encode([
            'success'  => true,
            'data_url' => $url,
        ]);
        exit;
    }

    $path = strtolower(parse_url($url, PHP_URL_PATH) ?? '');
    $allowed = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp'];
    $extOk = false;
    foreach ($allowed as $ext) {
        if (str_ends_with($path, $ext)) { $extOk = true; break; }
    }
    // Also allow extensionless CDN URLs
    if (!$extOk && !preg_match('#\.\w{1,5}$#', $path)) {
        $extOk = true;
    }
    if (!$extOk) {
        die(json_encode(['success' => false, 'error' => 'Not an image URL']));
    }

    $bytes = proxyFetch($url, 5, 2 * 1024 * 1024);
    if ($bytes === null) {
        die(json_encode(['success' => false, 'error' => 'Fetch failed']));
    }

    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime = $finfo->buffer($bytes);
    $validMimes = [
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml', 'image/bmp',
    ];
    if (!in_array($mime, $validMimes, true)) {
        $mime = 'image/png';
    }

    echo json_encode([
        'success'  => true,
        'data_url' => 'data:' . $mime . ';base64,' . base64_encode($bytes),
    ]);
    exit;
}


die(json_encode(['success' => false, 'error' => 'Unknown action: ' . $action]));
