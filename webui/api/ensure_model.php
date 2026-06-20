<?php

declare(strict_types=1);

/**
 * POST /api/ensure_model → engine POST /api/ensure_model
 *
 * Body: { "preset": "Standard|Anime|Realistic" }. Starts (or reports) the
 * download of that preset's models so the UI can show a "downloading model"
 * bar on preset selection. Transparent JSON passthrough.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['POST']);

forward(engine()->postRaw('/api/ensure_model', read_request_body()));
