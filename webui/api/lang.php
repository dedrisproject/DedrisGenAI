<?php

declare(strict_types=1);

/**
 * GET /api/lang?code=<it|en|de|fr|es>
 *
 * Serves a UI translation dictionary as JSON. This is a UI-local endpoint (it
 * does NOT proxy the engine): it reads webui/i18n/<code>.json so the front end
 * can fetch dictionaries same-origin regardless of how static files are served.
 *
 * If ?code is missing/unsupported, the language is detected from the request
 * (?lang override or Accept-Language) and falls back to English.
 *
 * Response: the flat { "key": "translation", ... } dictionary, plus a private
 * "_lang" field naming the language actually served.
 */

namespace DedrisGenAI\UI;

require_once __DIR__ . '/../lib/Config.php';
require_once __DIR__ . '/../lib/Lang.php';

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
if ($method === 'OPTIONS') {
    http_response_code(204);
    header('Allow: GET, OPTIONS');
    exit;
}
if ($method !== 'GET') {
    http_response_code(405);
    header('Content-Type: application/json; charset=utf-8');
    header('Allow: GET, OPTIONS');
    echo json_encode(['error' => 'method_not_allowed'], JSON_UNESCAPED_SLASHES);
    exit;
}

$requested = $_GET['code'] ?? ($_GET['lang'] ?? null);
$lang = is_string($requested) && Lang::isSupported(strtolower($requested))
    ? strtolower($requested)
    : Lang::detect();

$dict = Lang::load($lang);
$dict['_lang'] = $lang;

header('Content-Type: application/json; charset=utf-8');
// Dictionaries are static per language; let the browser cache briefly.
header('Cache-Control: public, max-age=300');
echo json_encode($dict, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
