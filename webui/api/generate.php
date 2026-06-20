<?php

declare(strict_types=1);

/**
 * POST /api/generate → engine POST /api/generate
 *
 * Transparent passthrough of the browser's JSON body (SPEC §5 generate body)
 * to the engine. The engine returns { "task_id":"<id>" }. We do NOT decode or
 * reshape the payload — it is forwarded byte-for-byte so the shape stays
 * exactly as the SPEC defines it.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['POST']);

$body = read_request_body();

forward(engine()->postRaw('/api/generate', $body));
