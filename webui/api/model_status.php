<?php

declare(strict_types=1);

/**
 * GET /api/model_status?preset=Standard|Anime|Realistic
 *   → engine GET /api/model_status?preset=...
 *
 * Reports whether the preset's models are present / downloading / ready, so the
 * UI can poll and show a "downloading model" progress bar. Verbatim passthrough.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['GET']);

$preset = isset($_GET['preset']) ? (string) $_GET['preset'] : '';
$query = $preset === '' ? [] : ['preset' => $preset];

forward(engine()->get('/api/model_status', $query));
