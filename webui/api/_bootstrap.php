<?php

declare(strict_types=1);

/**
 * Shared bootstrap for every DedrisGenAI PHP proxy endpoint.
 *
 * Responsibilities:
 *   - Load Config + EngineClient (manual PSR-4-ish require; no Composer).
 *   - Provide helpers to validate the HTTP method, read the request body,
 *     forward an EngineResponse verbatim, and emit JSON errors.
 *
 * Each endpoint in webui/api/*.php includes this file and uses these helpers.
 * The browser only ever talks to these endpoints — the engine port is never
 * exposed directly.
 */

namespace DedrisGenAI\UI;

require_once __DIR__ . '/../lib/Config.php';
require_once __DIR__ . '/../lib/EngineClient.php';

/**
 * Return the current request method (uppercased), defaulting to GET.
 */
function request_method(): string
{
    return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
}

/**
 * Ensure the request uses one of the allowed methods; otherwise emit 405 and
 * terminate. Always answers a CORS-style preflight OPTIONS with 204.
 *
 * @param array<int,string> $allowed e.g. ['GET'] or ['POST'].
 */
function require_method(array $allowed): void
{
    $method = request_method();

    if ($method === 'OPTIONS') {
        http_response_code(204);
        header('Allow: ' . implode(', ', array_merge($allowed, ['OPTIONS'])));
        exit;
    }

    if (!in_array($method, $allowed, true)) {
        http_response_code(405);
        header('Content-Type: application/json');
        header('Allow: ' . implode(', ', array_merge($allowed, ['OPTIONS'])));
        echo json_encode(['error' => 'method_not_allowed'], JSON_UNESCAPED_SLASHES);
        exit;
    }
}

/**
 * Read the raw request body (used for transparent passthrough of POST JSON).
 */
function read_request_body(): string
{
    $body = file_get_contents('php://input');
    return $body === false ? '' : $body;
}

/**
 * Forward an engine response to the browser verbatim and terminate.
 */
function forward(EngineResponse $response): void
{
    $response->send();
    exit;
}

/**
 * Emit a JSON error with the given HTTP status and terminate.
 *
 * @param array<string,mixed> $extra Optional additional fields.
 */
function json_error(int $status, string $error, array $extra = []): void
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json');
    }
    echo json_encode(array_merge(['error' => $error], $extra), JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * Shared EngineClient instance for the current request.
 */
function engine(): EngineClient
{
    static $client = null;
    if ($client === null) {
        $client = new EngineClient();
    }
    return $client;
}
