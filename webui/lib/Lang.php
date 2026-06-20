<?php

declare(strict_types=1);

namespace DedrisGenAI\UI;

/**
 * DedrisGenAI — i18n helper.
 *
 * Loads flat translation dictionaries from webui/i18n/<lang>.json. The UI is
 * available in five languages; the default is Italian. The browser also fetches
 * dictionaries directly through api/lang.php, but this helper lets the PHP shell
 * pick the correct <html lang>/<title> on first paint to avoid a flash.
 */
final class Lang
{
    /** Supported language codes (default first). */
    public const SUPPORTED = ['it', 'en', 'de', 'fr', 'es'];

    /** Default language when nothing else matches. */
    public const DEFAULT = 'it';

    /** Absolute path to the i18n directory (webui/i18n). */
    public static function dir(): string
    {
        return dirname(__DIR__) . '/i18n';
    }

    /**
     * True when $lang is one of the supported codes.
     */
    public static function isSupported(string $lang): bool
    {
        return in_array($lang, self::SUPPORTED, true);
    }

    /**
     * Normalise an arbitrary language tag (e.g. "it-IT", "EN", "de_DE") to a
     * supported 2-letter code, or the default when unsupported.
     */
    public static function normalize(?string $tag): string
    {
        if ($tag === null || $tag === '') {
            return self::DEFAULT;
        }
        $code = strtolower(substr(preg_replace('/[^A-Za-z]/', '', $tag), 0, 2));
        return self::isSupported($code) ? $code : self::DEFAULT;
    }

    /**
     * Best language for the current request: ?lang= override, otherwise the
     * Accept-Language header, otherwise the default.
     */
    public static function detect(): string
    {
        $q = $_GET['lang'] ?? null;
        if (is_string($q) && self::isSupported(strtolower($q))) {
            return strtolower($q);
        }

        $accept = $_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '';
        if (is_string($accept) && $accept !== '') {
            foreach (explode(',', $accept) as $part) {
                $tag = trim(explode(';', $part)[0]);
                $code = self::normalize($tag);
                if ($code !== self::DEFAULT || strtolower(substr($tag, 0, 2)) === self::DEFAULT) {
                    if (self::isSupported(strtolower(substr($tag, 0, 2)))) {
                        return strtolower(substr($tag, 0, 2));
                    }
                }
            }
        }

        return self::DEFAULT;
    }

    /**
     * Load and decode the dictionary for $lang. Falls back to the default
     * language, then to an empty map, so callers always get an array.
     *
     * @return array<string,string>
     */
    public static function load(string $lang): array
    {
        $lang = self::isSupported($lang) ? $lang : self::DEFAULT;
        $path = self::dir() . '/' . $lang . '.json';
        if (!is_file($path)) {
            $path = self::dir() . '/' . self::DEFAULT . '.json';
        }
        $raw = @file_get_contents($path);
        if ($raw === false) {
            return [];
        }
        $data = json_decode($raw, true);
        return is_array($data) ? $data : [];
    }

    /**
     * Translate a single key for $lang, returning $fallback (or the key) when
     * the key is missing. Handy for the PHP shell (title, html lang).
     */
    public static function t(string $lang, string $key, ?string $fallback = null): string
    {
        $dict = self::load($lang);
        if (isset($dict[$key])) {
            return $dict[$key];
        }
        return $fallback ?? $key;
    }
}
