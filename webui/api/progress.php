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

forward(engine()->get('/api/progress', ['task_id' => $taskId]));
