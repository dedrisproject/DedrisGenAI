<?php

declare(strict_types=1);

/**
 * GET /api/preset?name=Standard|Anime|Realistic → engine GET /api/preset?name=...
 *
 * Forwards the "name" query parameter and returns the preset's default
 * settings verbatim (SPEC §5).
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['GET']);

$name = isset($_GET['name']) ? (string) $_GET['name'] : '';
if ($name === '') {
    json_error(400, 'missing_name');
}

forward(engine()->get('/api/preset', ['name' => $name]));
