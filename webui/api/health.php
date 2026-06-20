<?php

declare(strict_types=1);

/**
 * GET /api/health → engine GET /api/health
 *
 * Returns: { "status":"ok", "version":"1.0.0", "device":"cuda|mps|cpu" }
 * (SPEC §5). On engine failure returns 503 {"error":"engine_unreachable"}.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['GET']);

forward(engine()->get('/api/health'));
