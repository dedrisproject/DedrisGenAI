<?php
/**
 * DedrisGenAI — router for PHP's built-in web server.
 *
 *   php -S 127.0.0.1:8888 -t webui/public webui/public/router.php
 *
 * Responsibilities:
 *   1. /api/*        -> dispatch to the matching PHP file in ../api/  (the proxy
 *                       layer that forwards to the engine). e.g. /api/options
 *                       -> webui/api/options.php
 *   2. /outputs/*    -> forward to the engine via the api passthrough so the
 *                       browser only ever talks to this origin.
 *   3. static assets -> served by the built-in server (return false).
 *   4. everything else -> index.php (SPA fallback).
 *
 * The heavy lifting (engine calls, config) lives in webui/api/ and webui/lib/,
 * which this front-end agent does not own. This router only dispatches.
 *
 * Namespace: DedrisGenAI\UI
 */
declare(strict_types=1);

$publicDir = __DIR__;
$apiDir    = dirname(__DIR__) . '/api';

$uri  = urldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/');
$path = '/' . ltrim($uri, '/');

/* ------------------------------------------------------------------ helpers */

/** Reject any path component that could escape the intended directory. */
function dedris_safe_segment(string $seg): bool
{
    return $seg !== '' && $seg !== '.' && $seg !== '..' && strpos($seg, "\0") === false;
}

/** Dispatch into a PHP file inside the api/ directory, preserving the rest as PATH_INFO. */
function dedris_dispatch_api(string $apiDir, string $rest): bool
{
    $rest = ltrim($rest, '/');                    // e.g. "options" or "preset"
    $parts = $rest === '' ? [] : explode('/', $rest);
    foreach ($parts as $p) {
        if (!dedris_safe_segment($p)) {
            http_response_code(400);
            header('Content-Type: application/json');
            echo json_encode(['error' => 'bad request']);
            return true;
        }
    }

    $first = $parts[0] ?? '';
    if ($first === '') {
        // /api or /api/ -> health summary if available, else index
        $first = 'index';
    }

    // Map "/api/<name>[/<extra>]" to "<apiDir>/<name>.php"
    $candidate = $apiDir . '/' . $first . '.php';
    if (is_file($candidate)) {
        // Provide the remainder as PATH_INFO for endpoints that want sub-paths.
        $extra = implode('/', array_slice($parts, 1));
        $_SERVER['PATH_INFO']        = $extra === '' ? '' : '/' . $extra;
        $_SERVER['SCRIPT_NAME']      = '/api/' . $first . '.php';
        $_SERVER['SCRIPT_FILENAME']  = $candidate;
        $_SERVER['DEDRIS_API_ROUTE'] = $first;
        require $candidate;
        return true;
    }

    // Some setups put a single front controller (index.php) in api/.
    $front = $apiDir . '/index.php';
    if (is_file($front)) {
        $_SERVER['PATH_INFO']       = '/' . $rest;
        $_SERVER['SCRIPT_FILENAME'] = $front;
        require $front;
        return true;
    }

    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode([
        'error'   => 'engine proxy not available',
        'detail'  => 'No handler for /api/' . $first . '. The API proxy layer (webui/api/) may not be installed yet.',
        'state'   => 'starting',
    ]);
    return true;
}

/** Forward an /outputs/* request through the api passthrough so it stays same-origin. */
function dedris_dispatch_outputs(string $apiDir, string $path): bool
{
    // Preferred: a dedicated passthrough endpoint owned by the api/ agent.
    foreach (['outputs.php', 'output.php', 'image.php'] as $name) {
        $candidate = $apiDir . '/' . $name;
        if (is_file($candidate)) {
            // pass the requested file path along for the handler
            $_SERVER['PATH_INFO']       = $path;                 // "/outputs/xxxx.png"
            $_SERVER['DEDRIS_OUTPUT']   = ltrim(substr($path, strlen('/outputs')), '/');
            $_SERVER['SCRIPT_FILENAME'] = $candidate;
            require $candidate;
            return true;
        }
    }
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'output passthrough not available']);
    return true;
}

/** Forward a /styles/* request (style preview thumbnails) through the api passthrough. */
function dedris_dispatch_styles(string $apiDir, string $path): bool
{
    $candidate = $apiDir . '/styles.php';
    if (is_file($candidate)) {
        $_SERVER['PATH_INFO']       = $path;                 // "/styles/samples/xxx.jpg"
        $_SERVER['SCRIPT_FILENAME'] = $candidate;
        require $candidate;
        return true;
    }
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'styles passthrough not available']);
    return true;
}

/* ------------------------------------------------------------------ routing */

// 1) API proxy
if (strpos($path, '/api/') === 0 || $path === '/api') {
    return dedris_dispatch_api($apiDir, substr($path, strlen('/api')));
}

// 2) Engine output images (kept same-origin via the api layer)
if (strpos($path, '/outputs/') === 0 || $path === '/outputs') {
    return dedris_dispatch_outputs($apiDir, $path);
}

// 2b) Engine style preview thumbnails (kept same-origin via the api layer)
if (strpos($path, '/styles/') === 0 || $path === '/styles') {
    return dedris_dispatch_styles($apiDir, $path);
}

// 2c) Examples / Demo page — allow the extension-less /demo to reach demo.php.
//     (demo.php itself is a real file and is served by the static branch below.)
if ($path === '/demo' || $path === '/demo/') {
    require $publicDir . '/demo.php';
    return true;
}

// 3) Static assets — let the built-in server stream them as-is.
//    Returning false tells `php -S` to serve the requested file directly.
$requested = realpath($publicDir . $path);
if (
    $path !== '/' &&
    $requested !== false &&
    is_file($requested) &&
    strpos($requested, $publicDir) === 0
) {
    return false;
}

// 4) SPA fallback -> index.php
require $publicDir . '/index.php';
return true;
