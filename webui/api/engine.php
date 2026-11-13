<?php

declare(strict_types=1);

/**
 * Engine supervisor bridge (engine/supervisor.py control API).
 *
 *   GET  /api/engine                      -> supervisor GET /status
 *        { "supervised":true, "state":"starting|running|unresponsive|restarting|backoff|failed|stopped",
 *          "pid":123, "restarts":0, "last_exit_reason":"...", "last_exit_kind":"crash|restart", "oom_suspected":false, ...,
 *          "restart_allowed":true }
 *        When the engine was started without the supervisor (e.g. `python server.py`
 *        by hand), answers 200 { "supervised":false, "restart_allowed":false }.
 *
 *   POST /api/engine  { "action":"restart" } -> supervisor POST /restart (202)
 *        Kills the engine process (if any) and starts a fresh one. Any running
 *        generation is lost. Disabled with DEDRIS_ALLOW_ENGINE_RESTART=0 (403).
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['GET', 'POST']);

$supervisor = new EngineClient(3, 10, Config::supervisorBaseUrl());
$allowed = Config::engineRestartAllowed();

if (request_method() === 'GET') {
    $res = $supervisor->get('/status');
    $data = json_decode($res->body, true);
    if ($res->status !== 200 || !is_array($data)) {
        $data = ['supervised' => false];
    }
    $data['restart_allowed'] = $allowed && !empty($data['supervised']);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

$body = json_decode(read_request_body(), true);
$action = is_array($body) ? (string) ($body['action'] ?? '') : '';
if ($action !== 'restart') {
    json_error(400, 'unknown_action');
}
if (!$allowed) {
    json_error(403, 'restart_disabled');
}

$res = $supervisor->post('/restart');
if ($res->status === 503) {
    json_error(503, 'not_supervised');
}
forward($res);
