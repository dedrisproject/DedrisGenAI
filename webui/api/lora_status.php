<?php

declare(strict_types=1);

/**
 * GET /api/lora_status → engine GET /api/lora_status
 *
 * Reports the state of the current "add LoRA from URL" download so the UI can show
 * a progress bar and refresh the LoRA selectors when done. Verbatim passthrough:
 *   { state, message, file, downloaded_bytes, total_bytes, lora_name }
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['GET']);

forward(engine()->get('/api/lora_status'));
