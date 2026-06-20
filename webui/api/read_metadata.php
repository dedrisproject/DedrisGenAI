<?php

declare(strict_types=1);

/**
 * POST /api/read_metadata → engine POST /api/read_metadata
 *
 * Body: { "image": "<dataURL of an image created by DedrisGenAI>" }
 * Returns { "found": bool, "params": { ...generate-body fields... }, "raw": {...} }
 * so the UI can restore the parameters. Transparent JSON passthrough.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['POST']);

forward(engine()->postRaw('/api/read_metadata', read_request_body()));
