<?php

declare(strict_types=1);

namespace DedrisGenAI\UI;

/**
 * Runtime configuration for the DedrisGenAI PHP UI proxy layer.
 *
 * Ports are read from the environment (see SPEC §5 / §7):
 *   - DEDRIS_UI_PORT     (default 8888) — port the PHP UI listens on.
 *   - DEDRIS_ENGINE_PORT (default 7866) — port the Python engine listens on.
 *
 * The engine is always bound to localhost only and must never be exposed to
 * the browser directly; the api/* endpoints are the only bridge.
 */
final class Config
{
    /** Default port for the PHP UI server. */
    public const DEFAULT_UI_PORT = 8888;

    /** Default port for the Python engine HTTP service. */
    public const DEFAULT_ENGINE_PORT = 7866;

    /** The engine is reached over loopback only. */
    public const ENGINE_HOST = '127.0.0.1';

    /**
     * Port the PHP UI listens on. Reads DEDRIS_UI_PORT, falling back to 8888.
     */
    public static function uiPort(): int
    {
        return self::readPort('DEDRIS_UI_PORT', self::DEFAULT_UI_PORT);
    }

    /**
     * Port the engine listens on. Reads DEDRIS_ENGINE_PORT, falling back to 7866.
     */
    public static function enginePort(): int
    {
        return self::readPort('DEDRIS_ENGINE_PORT', self::DEFAULT_ENGINE_PORT);
    }

    /**
     * Base URL of the engine, e.g. "http://127.0.0.1:7866" (no trailing slash).
     */
    public static function engineBaseUrl(): string
    {
        return sprintf('http://%s:%d', self::ENGINE_HOST, self::enginePort());
    }

    /**
     * Build a full engine URL for the given path (which should start with "/").
     */
    public static function engineUrl(string $path): string
    {
        if ($path === '' || $path[0] !== '/') {
            $path = '/' . $path;
        }

        return self::engineBaseUrl() . $path;
    }

    /**
     * Read an integer port from the environment with a safe fallback.
     *
     * An empty, non-numeric, or out-of-range value falls back to $default so a
     * misconfigured env var can never break the proxy.
     */
    private static function readPort(string $name, int $default): int
    {
        $raw = getenv($name);
        if ($raw === false || $raw === '') {
            return $default;
        }

        if (!is_numeric($raw)) {
            return $default;
        }

        $port = (int) $raw;
        if ($port < 1 || $port > 65535) {
            return $default;
        }

        return $port;
    }
}
