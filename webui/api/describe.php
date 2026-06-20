<?php

declare(strict_types=1);

/**
 * POST /api/describe → engine POST /api/describe
 *
 * Body: { "image": "<dataURL>", "types": ["Photograph","Art/Anime"] }
 * Runs the engine's image interrogation and returns { "prompt": "<text>" }.
 * Transparent JSON passthrough.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['POST']);

forward(engine()->postRaw('/api/describe', read_request_body()));
