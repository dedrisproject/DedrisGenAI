<?php

declare(strict_types=1);

/**
 * GET /api/options → engine GET /api/options
 *
 * Returns everything the UI needs to render (presets, performances,
 * aspect_ratios, samplers, schedulers, output_formats, styles, models) per
 * SPEC §5. Body is forwarded verbatim — no reshaping.
 */

namespace DedrisGenAI\UI;

require __DIR__ . '/_bootstrap.php';

require_method(['GET']);

forward(engine()->get('/api/options'));
