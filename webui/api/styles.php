<?php

declare(strict_types=1);

/**
 * Image passthrough for engine GET /styles/<path>.
 *
 * The engine serves style preview thumbnails at:
 *   /styles/samples/<slug>.jpg   (shipped sample images)
 *   /styles/previews/<slug>.jpg  (generated result previews)
 *
 * /api/options returns those URLs verbatim, and the browser loads them from this
 * same origin. The router (webui/public/router.php) maps /styles/* onto this
 * script, which streams the engine response through with the upstream
 * Content-Type — never exposing the engine port to the browser.
 *
 * Path resolution precedence: ?path=, then PATH_INFO, then REQUEST_URI.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['GET']);

/** Resolve the engine path to stream, normalized to start with "/styles/". */
function resolve_styles_path(): ?string
{
    if (isset($_GET['path']) && $_GET['path'] !== '') {
        return normalize_styles_path((string) $_GET['path']);
    }
    if (isset($_SERVER['PATH_INFO']) && $_SERVER['PATH_INFO'] !== '') {
        return normalize_styles_path((string) $_SERVER['PATH_INFO']);
    }
    if (isset($_SERVER['REQUEST_URI'])) {
        $uri = explode('?', (string) $_SERVER['REQUEST_URI'], 2)[0];
        $pos = strpos($uri, '/styles/');
        if ($pos !== false) {
            return normalize_styles_path(substr($uri, $pos));
        }
    }
    return null;
}

/** Sanitize and force the /styles/ prefix; reject traversal. */
function normalize_styles_path(string $path): ?string
{
    $path = '/' . ltrim($path, '/');

    if (strpos($path, '/api/') === 0) {
        $path = substr($path, 4);
    }
    if (strpos($path, '/styles/') !== 0 && $path !== '/styles') {
        $path = '/styles/' . ltrim($path, '/');
    }

    $decoded = rawurldecode($path);
    if (strpos($decoded, '..') !== false || strpos($decoded, "\0") !== false) {
        return null;
    }
    return $path;
}

$path = resolve_styles_path();
if ($path === null) {
    json_error(400, 'invalid_styles_path');
}

engine()->stream($path);
