<?php

declare(strict_types=1);

/**
 * POST /api/add_lora → engine POST /api/add_lora
 *
 * Body: { "url": "<civitai or direct .safetensors url>", "token": "<optional civitai api token>" }
 * Starts a background download of the LoRA into the engine's models/loras folder.
 * Transparent JSON passthrough. Poll /api/lora_status for progress.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['POST']);

forward(engine()->postRaw('/api/add_lora', read_request_body()));
