<?php

declare(strict_types=1);

use DedrisGenAI\PhpApi\PromptExecutor;

require __DIR__ . '/PromptExecutor.php';

$host = getenv('PROMPT_API_HOST') ?: '127.0.0.1';
$port = (int) (getenv('PROMPT_API_PORT') ?: 8080);

$endpoint = sprintf('tcp://%s:%d', $host, $port);

$server = @stream_socket_server($endpoint, $errno, $errstr);
if ($server === false) {
    fwrite(STDERR, sprintf("Failed to start server on %s: [%d] %s\n", $endpoint, $errno, $errstr));
    exit(1);
}

stream_set_blocking($server, true);

$shouldRun = true;

$signalHandler = static function () use (&$shouldRun): void {
    $shouldRun = false;
};

if (function_exists('pcntl_signal')) {
    pcntl_signal(SIGINT, $signalHandler);
    pcntl_signal(SIGTERM, $signalHandler);
}

$executor = new PromptExecutor();

fwrite(STDOUT, sprintf("Prompt API daemon listening on %s\n", $endpoint));

while ($shouldRun) {
    if (function_exists('pcntl_signal_dispatch')) {
        pcntl_signal_dispatch();
    }

    $client = @stream_socket_accept($server, 1);
    if ($client === false) {
        continue;
    }

    handleClient($client, $executor);
}

fclose($server);

function handleClient($client, PromptExecutor $executor): void
{
    stream_set_timeout($client, 5);

    $requestLine = fgets($client);
    if ($requestLine === false) {
        fclose($client);
        return;
    }

    $requestLine = trim($requestLine);
    if ($requestLine === '') {
        fclose($client);
        return;
    }

    $headers = [];
    while (($line = fgets($client)) !== false) {
        $line = rtrim($line, "\r\n");
        if ($line === '') {
            break;
        }
        $parts = explode(':', $line, 2);
        if (count($parts) === 2) {
            $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
        }
    }

    $contentLength = isset($headers['content-length']) ? (int) $headers['content-length'] : 0;
    $body = '';
    if ($contentLength > 0) {
        $body = stream_get_contents($client, $contentLength) ?: '';
    }

    [$method, $path] = parseRequestLine($requestLine);

    if ($method === 'GET' && $path === '/health') {
        respondJson($client, 200, ['status' => 'ok']);
        return;
    }

    if ($method === 'OPTIONS' && $path === '/execute') {
        respondNoContent($client);
        return;
    }

    if ($method !== 'POST' || $path !== '/execute') {
        respondJson($client, 404, ['error' => 'Not found']);
        return;
    }

    $data = json_decode($body, true);
    if (!is_array($data) || !array_key_exists('prompt', $data)) {
        respondJson($client, 400, ['error' => 'Invalid payload: expected JSON with a "prompt" field.']);
        return;
    }

    try {
        $result = $executor->execute((string) $data['prompt']);
    } catch (Throwable $throwable) {
        respondJson($client, 500, [
            'error' => 'Failed to execute prompt.',
            'details' => $throwable->getMessage(),
        ]);
        return;
    }

    respondJson($client, 200, [
        'status' => 'success',
        'result' => $result,
    ]);
}

function parseRequestLine(string $requestLine): array
{
    $parts = explode(' ', $requestLine);
    $method = strtoupper($parts[0] ?? '');
    $path = $parts[1] ?? '/';

    return [$method, $path];
}

function respondJson($client, int $statusCode, array $payload): void
{
    $statusText = match ($statusCode) {
        200 => 'OK',
        400 => 'Bad Request',
        404 => 'Not Found',
        500 => 'Internal Server Error',
        default => 'OK',
    };

    $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($body === false) {
        $body = json_encode(['error' => 'Failed to encode response.']);
    }

    $headers = [
        sprintf('HTTP/1.1 %d %s', $statusCode, $statusText),
        'Content-Type: application/json; charset=utf-8',
        'Connection: close',
        'Content-Length: ' . strlen((string) $body),
        'Access-Control-Allow-Origin: *',
        'Access-Control-Allow-Headers: Content-Type',
        'Access-Control-Allow-Methods: GET, POST, OPTIONS',
    ];

    fwrite($client, implode("\r\n", $headers) . "\r\n\r\n" . $body);
    fclose($client);
}

function respondNoContent($client): void
{
    $headers = [
        'HTTP/1.1 204 No Content',
        'Connection: close',
        'Access-Control-Allow-Origin: *',
        'Access-Control-Allow-Headers: Content-Type',
        'Access-Control-Allow-Methods: GET, POST, OPTIONS',
    ];

    fwrite($client, implode("\r\n", $headers) . "\r\n\r\n");
    fclose($client);
}
