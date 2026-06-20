<?php

declare(strict_types=1);

namespace DedrisGenAI\UI;

/**
 * Minimal HTTP client used to forward browser requests to the local engine.
 *
 * Prefers cURL when available, falling back to PHP stream contexts so the
 * proxy works on any plain PHP build with no Composer dependencies.
 *
 * On connection failure (engine not yet started) every method returns a
 * structured EngineResponse with HTTP 503 and a JSON body
 * {"error":"engine_unreachable"} so the UI can show an "engine starting" state.
 */
final class EngineClient
{
    /** Connection timeout in seconds (how long to wait to reach the engine). */
    private int $connectTimeout;

    /** Total request timeout in seconds (generation kicks off fast; long work is polled). */
    private int $timeout;

    public function __construct(int $connectTimeout = 5, int $timeout = 30)
    {
        $this->connectTimeout = $connectTimeout;
        $this->timeout = $timeout;
    }

    /**
     * GET an engine endpoint, returning the engine's response verbatim.
     *
     * @param string               $path  Engine path, e.g. "/api/options".
     * @param array<string,mixed>  $query Optional query parameters.
     */
    public function get(string $path, array $query = []): EngineResponse
    {
        $url = Config::engineUrl($path);
        if ($query !== []) {
            $url .= (strpos($path, '?') === false ? '?' : '&') . http_build_query($query);
        }

        return $this->request('GET', $url, null, ['Accept: application/json']);
    }

    /**
     * POST a JSON body to an engine endpoint, returning the response verbatim.
     *
     * @param array<string,mixed>|list<mixed> $jsonArray Body to JSON-encode.
     */
    public function post(string $path, array $jsonArray = []): EngineResponse
    {
        $url = Config::engineUrl($path);
        $body = json_encode($jsonArray, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($body === false) {
            $body = '{}';
        }

        return $this->request(
            'POST',
            $url,
            $body,
            [
                'Content-Type: application/json',
                'Accept: application/json',
                'Content-Length: ' . strlen($body),
            ]
        );
    }

    /**
     * POST a raw, already-serialized body (passthrough of the browser request).
     *
     * Used by generate.php so we forward exactly what the browser sent without
     * decoding/re-encoding and potentially reshaping the JSON.
     */
    public function postRaw(string $path, string $rawBody, string $contentType = 'application/json'): EngineResponse
    {
        $url = Config::engineUrl($path);

        return $this->request(
            'POST',
            $url,
            $rawBody,
            [
                'Content-Type: ' . $contentType,
                'Accept: application/json',
                'Content-Length: ' . strlen($rawBody),
            ]
        );
    }

    /**
     * Stream an engine resource (e.g. an image under /outputs/<path>) straight
     * to the browser without buffering the whole payload in memory.
     *
     * Emits the upstream status code and Content-Type, then writes the body to
     * the PHP output stream. On connection failure it emits a 503 JSON error.
     * Returns true when the resource was streamed, false on engine failure.
     */
    public function stream(string $path, array $query = []): bool
    {
        $url = Config::engineUrl($path);
        if ($query !== []) {
            $url .= (strpos($path, '?') === false ? '?' : '&') . http_build_query($query);
        }

        if (function_exists('curl_init')) {
            return $this->streamCurl($url);
        }

        return $this->streamStream($url);
    }

    /**
     * Perform an HTTP request, returning a structured EngineResponse.
     *
     * @param array<int,string> $headers
     */
    private function request(string $method, string $url, ?string $body, array $headers): EngineResponse
    {
        if (function_exists('curl_init')) {
            return $this->requestCurl($method, $url, $body, $headers);
        }

        return $this->requestStream($method, $url, $body, $headers);
    }

    /**
     * @param array<int,string> $headers
     */
    private function requestCurl(string $method, string $url, ?string $body, array $headers): EngineResponse
    {
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => false,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CONNECTTIMEOUT => $this->connectTimeout,
            CURLOPT_TIMEOUT => $this->timeout,
        ]);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $response = curl_exec($ch);
        if ($response === false) {
            curl_close($ch);
            return EngineResponse::unreachable();
        }

        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        curl_close($ch);

        return new EngineResponse(
            $status,
            (string) $response,
            is_string($contentType) && $contentType !== '' ? $contentType : 'application/json'
        );
    }

    /**
     * @param array<int,string> $headers
     */
    private function requestStream(string $method, string $url, ?string $body, array $headers): EngineResponse
    {
        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $headers),
                'content' => $body ?? '',
                'timeout' => $this->timeout,
                'ignore_errors' => true, // capture body even on 4xx/5xx
            ],
        ]);

        $response = @file_get_contents($url, false, $context);
        if ($response === false) {
            return EngineResponse::unreachable();
        }

        // $http_response_header is populated by the stream wrapper.
        $status = 200;
        $contentType = 'application/json';
        if (isset($http_response_header) && is_array($http_response_header)) {
            $status = self::parseStatusCode($http_response_header) ?? 200;
            $contentType = self::parseContentType($http_response_header) ?? 'application/json';
        }

        return new EngineResponse($status, $response, $contentType);
    }

    private function streamCurl(string $url): bool
    {
        $ch = curl_init();
        $headerSent = false;
        $statusEmitted = 200;

        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_HTTPGET => true,
            CURLOPT_CONNECTTIMEOUT => $this->connectTimeout,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_HEADER => false,
            CURLOPT_HEADERFUNCTION => function ($curl, string $headerLine) use (&$statusEmitted): int {
                $trimmed = trim($headerLine);
                if (stripos($trimmed, 'Content-Type:') === 0) {
                    // forward the upstream content type
                    header($trimmed);
                }
                return strlen($headerLine);
            },
            CURLOPT_WRITEFUNCTION => function ($curl, string $chunk) use (&$headerSent, &$statusEmitted): int {
                if (!$headerSent) {
                    $code = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
                    if ($code > 0) {
                        $statusEmitted = $code;
                        http_response_code($code);
                    }
                    $headerSent = true;
                }
                echo $chunk;
                return strlen($chunk);
            },
        ]);

        $ok = curl_exec($ch);
        $failed = ($ok === false);
        $finalCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($failed && !$headerSent) {
            EngineResponse::unreachable()->send();
            return false;
        }

        // Empty-body responses (e.g. an upstream 404) never trip the write
        // callback, so emit the final status code here if it wasn't already.
        if (!$headerSent && !headers_sent() && $finalCode > 0) {
            http_response_code($finalCode);
        }

        return !$failed;
    }

    private function streamStream(string $url): bool
    {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'timeout' => $this->timeout,
                'ignore_errors' => true,
            ],
        ]);

        $handle = @fopen($url, 'rb', false, $context);
        if ($handle === false) {
            EngineResponse::unreachable()->send();
            return false;
        }

        $status = 200;
        $contentType = 'application/octet-stream';
        if (isset($http_response_header) && is_array($http_response_header)) {
            $status = self::parseStatusCode($http_response_header) ?? 200;
            $contentType = self::parseContentType($http_response_header) ?? 'application/octet-stream';
        }

        http_response_code($status);
        header('Content-Type: ' . $contentType);

        while (!feof($handle)) {
            $chunk = fread($handle, 8192);
            if ($chunk === false) {
                break;
            }
            echo $chunk;
        }
        fclose($handle);

        return true;
    }

    /**
     * @param array<int,string> $headerLines
     */
    private static function parseStatusCode(array $headerLines): ?int
    {
        foreach ($headerLines as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m) === 1) {
                // last status line wins (handles redirects)
                $status = (int) $m[1];
            }
        }

        return isset($status) ? $status : null;
    }

    /**
     * @param array<int,string> $headerLines
     */
    private static function parseContentType(array $headerLines): ?string
    {
        $contentType = null;
        foreach ($headerLines as $line) {
            if (stripos($line, 'Content-Type:') === 0) {
                $contentType = trim(substr($line, strlen('Content-Type:')));
            }
        }

        return $contentType;
    }
}

/**
 * Immutable result of an engine request: status code, raw body, content type.
 */
final class EngineResponse
{
    public int $status;
    public string $body;
    public string $contentType;

    public function __construct(int $status, string $body, string $contentType = 'application/json')
    {
        $this->status = $status;
        $this->body = $body;
        $this->contentType = $contentType;
    }

    /**
     * Canonical "engine not reachable" response (HTTP 503).
     */
    public static function unreachable(): self
    {
        return new self(
            503,
            json_encode(['error' => 'engine_unreachable'], JSON_UNESCAPED_SLASHES),
            'application/json'
        );
    }

    /**
     * Emit this response to the browser verbatim (status, content-type, body).
     */
    public function send(): void
    {
        if (!headers_sent()) {
            http_response_code($this->status);
            header('Content-Type: ' . $this->contentType);
        }
        echo $this->body;
    }
}
