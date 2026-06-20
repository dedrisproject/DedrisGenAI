<?php

declare(strict_types=1);

/**
 * Image passthrough for engine GET /outputs/<path> (SPEC §5).
 *
 * The router (webui/public/router.php) maps browser requests for /outputs/*
 * onto this script. We resolve the requested output path, then stream the
 * engine's image response straight through to the browser with the upstream
 * Content-Type — never buffering the whole file and never exposing the engine
 * port to the browser.
 *
 * The path can be provided (in order of precedence) by:
 *   1. $_GET['path']           — explicit, e.g. router sets ?path=/outputs/x.png
 *   2. $_SERVER['PATH_INFO']   — e.g. /outputs.php/2024-01-01/foo.png
 *   3. $_SERVER['REQUEST_URI'] — fallback: forward the /outputs/... portion
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['GET']);

/**
 * Resolve the engine path to stream, normalized to start with "/outputs/".
 * Returns null when no valid /outputs path can be determined.
 */
function resolve_output_path(): ?string
{
    // 1) Explicit ?path= override.
    if (isset($_GET['path']) && $_GET['path'] !== '') {
        return normalize_output_path((string) $_GET['path']);
    }

    // 2) PATH_INFO (PHP populates this when extra path follows the script name).
    if (isset($_SERVER['PATH_INFO']) && $_SERVER['PATH_INFO'] !== '') {
        return normalize_output_path((string) $_SERVER['PATH_INFO']);
    }

    // 3) Fall back to the raw request URI, extracting the /outputs/... part.
    if (isset($_SERVER['REQUEST_URI'])) {
        $uri = (string) $_SERVER['REQUEST_URI'];
        $uri = explode('?', $uri, 2)[0]; // drop any query string
        $pos = strpos($uri, '/outputs/');
        if ($pos !== false) {
            return normalize_output_path(substr($uri, $pos));
        }
    }

    return null;
}

/**
 * Sanitize and normalize a candidate path so it safely targets /outputs/.
 *
 * Rejects path traversal ("..") and forces the /outputs/ prefix so this
 * endpoint can only ever read generated images from the engine.
 */
function normalize_output_path(string $path): ?string
{
    $path = '/' . ltrim($path, '/');

    // Strip a leading /api if a caller accidentally included it.
    if (strpos($path, '/api/') === 0) {
        $path = substr($path, 4);
    }

    // Ensure it lives under /outputs/.
    if (strpos($path, '/outputs/') !== 0 && $path !== '/outputs') {
        // Treat a bare filename / relative path as relative to /outputs/.
        $path = '/outputs/' . ltrim($path, '/');
    }

    // Reject traversal attempts after URL-decoding the segments.
    $decoded = rawurldecode($path);
    if (strpos($decoded, '..') !== false || strpos($decoded, "\0") !== false) {
        return null;
    }

    return $path;
}

$path = resolve_output_path();
if ($path === null) {
    json_error(400, 'invalid_output_path');
}

// Stream the engine image straight to the browser (handles 503 internally).
engine()->stream($path);
