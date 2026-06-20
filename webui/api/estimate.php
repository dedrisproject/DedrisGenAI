<?php

declare(strict_types=1);

/**
 * GET /api/estimate?performance=&image_number=&aspect_ratio=&steps_override=
 *   → engine GET /api/estimate?...
 *
 * Forwards the generation-settings query params and returns the engine's
 * time-estimate JSON verbatim:
 *   { device, device_name, steps, seconds_per_image, total_seconds, calibrated, note }
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['GET']);

$query = [];
foreach (['performance', 'image_number', 'aspect_ratio', 'steps_override'] as $k) {
    if (isset($_GET[$k]) && $_GET[$k] !== '') {
        $query[$k] = (string) $_GET[$k];
    }
}

forward(engine()->get('/api/estimate', $query));
