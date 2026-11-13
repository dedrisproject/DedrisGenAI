<?php

declare(strict_types=1);

/**
 * GET /api/progress?task_id=ID → engine GET /api/progress?task_id=ID
 *
 * Returns the task state per SPEC §5:
 *   { "state":"pending|running|done|error|stopped", "progress":0-100,
 *     "preview":"<dataURL|null>", "message":"...",
 *     "images":["/outputs/...png", ...] }
 * Forwarded verbatim.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['GET']);

$taskId = isset($_GET['task_id']) ? (string) $_GET['task_id'] : '';
if ($taskId === '') {
    json_error(400, 'missing_task_id');
}

// Short timeout: progress answers instantly when the engine is healthy, so a slow
// reply means it is hung — fail fast so the UI can say so (and offer a restart)
// instead of waiting for the generic 120s proxy timeout.
forward((new EngineClient(5, 15))->get('/api/progress', ['task_id' => $taskId]));
