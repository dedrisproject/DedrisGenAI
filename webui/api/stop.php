<?php

declare(strict_types=1);

/**
 * POST /api/stop → engine POST /api/stop
 *
 * Body: { "task_id":"ID" } (SPEC §5). Cancels the current/queued task.
 * The browser's JSON body is forwarded verbatim.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['POST']);

$body = read_request_body();

forward(engine()->postRaw('/api/stop', $body));
