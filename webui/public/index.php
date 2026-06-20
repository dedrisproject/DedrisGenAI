<?php
/**
 * DedrisGenAI — Web UI (single-page front end)
 *
 * This file only renders the static shell. All dynamic data (options, presets,
 * model lists) and the full generation flow are driven by assets/js/app.js,
 * which talks exclusively to the same-origin /api/* proxy layer (webui/api/*),
 * never to the engine directly.
 *
 * Internationalisation:
 *   - Translatable text carries data-i18n="<key>" (and data-i18n-placeholder /
 *     data-i18n-title / data-i18n-aria-label for attributes); app.js fetches the
 *     dictionary from api/lang and applies it on load + on language change.
 *   - The PHP shell pre-selects the language for <html lang>/<title> from the
 *     request (Accept-Language / ?lang), defaulting to English, to avoid a flash
 *     of untranslated content. The client may still override via localStorage.
 *
 * Namespace: DedrisGenAI\UI
 */
declare(strict_types=1);

require_once dirname(__DIR__) . '/lib/Lang.php';

use DedrisGenAI\UI\Lang;

// Cache-busting token for static assets (mtime based, falls back to date).
$asset_ver = static function (string $rel): string {
    $path = __DIR__ . '/' . ltrim($rel, '/');
    $mt = @filemtime($path);
    return $mt ? (string) $mt : date('Ymd');
};

// Server-side language guess (client localStorage may override after load).
$lang  = Lang::detect();
$t     = static fn (string $k, string $f = ''): string => Lang::t($lang, $k, $f);
$langs = [];
foreach (Lang::SUPPORTED as $code) {
    $langs[$code] = Lang::t($code, '_meta.name', strtoupper($code));
}
?><!DOCTYPE html>
<html lang="<?= htmlspecialchars($lang, ENT_QUOTES) ?>" data-default-lang="<?= htmlspecialchars(Lang::DEFAULT, ENT_QUOTES) ?>">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title data-i18n="app.title"><?= htmlspecialchars($t('app.title', 'DedrisGenAI — AI Image Studio'), ENT_QUOTES) ?></title>
  <meta name="description" content="DedrisGenAI — Standard, Anime & Realistic AI image generation.">
  <link rel="icon" type="image/svg+xml" href="assets/img/logo.svg">
  <link rel="stylesheet" href="assets/css/style.css?v=<?= $asset_ver('assets/css/style.css') ?>">
  <script>
    /* Apply persisted UI mode + language as early as possible to avoid layout
       jumps / flashes. app.js refines this once the dictionary is loaded. */
    (function () {
      try {
        var supported = <?= json_encode(array_keys($langs), JSON_UNESCAPED_SLASHES) ?>;
        var def = <?= json_encode(Lang::DEFAULT) ?>;
        var mode = localStorage.getItem('dedris.mode');
        if (mode !== 'advanced' && mode !== 'simple') mode = 'simple';
        document.documentElement.classList.add('mode-' + mode);
        var lang = localStorage.getItem('dedris.lang');
        if (!lang || supported.indexOf(lang) === -1) {
          var nav = (navigator.language || navigator.userLanguage || def).slice(0, 2).toLowerCase();
          lang = supported.indexOf(nav) !== -1 ? nav : def;
        }
        document.documentElement.setAttribute('lang', lang);
      } catch (e) { document.documentElement.classList.add('mode-simple'); }
    })();
  </script>
</head>
<body>

  <!-- ======================= TOP BAR ======================= -->
  <header class="topbar">
    <div class="brand">
      <img src="assets/img/logo.svg" alt="DedrisGenAI">
      <span class="tagline hidden-sm" data-i18n="app.tagline"><?= htmlspecialchars($t('app.tagline', 'AI Image Studio'), ENT_QUOTES) ?></span>
    </div>

    <div class="preset-group">
      <label for="preset" data-i18n="preset.label"><?= htmlspecialchars($t('preset.label', 'Preset'), ENT_QUOTES) ?></label>
      <div class="seg" id="preset" role="radiogroup" data-i18n-aria-label="preset.aria" aria-label="<?= htmlspecialchars($t('preset.aria', 'Model preset'), ENT_QUOTES) ?>">
        <!-- filled from /api/options -->
      </div>
    </div>

    <!-- Simple / Advanced mode toggle -->
    <div class="mode-toggle" role="radiogroup" data-i18n-aria-label="mode.label" aria-label="<?= htmlspecialchars($t('mode.label', 'Interface'), ENT_QUOTES) ?>">
      <button type="button" class="mode-btn" data-mode="simple" role="radio"
              data-i18n="mode.simple" data-i18n-title="mode.simple.tip"
              title="<?= htmlspecialchars($t('mode.simple.tip', ''), ENT_QUOTES) ?>"><?= htmlspecialchars($t('mode.simple', 'Simple'), ENT_QUOTES) ?></button>
      <button type="button" class="mode-btn" data-mode="advanced" role="radio"
              data-i18n="mode.advanced" data-i18n-title="mode.advanced.tip"
              title="<?= htmlspecialchars($t('mode.advanced.tip', ''), ENT_QUOTES) ?>"><?= htmlspecialchars($t('mode.advanced', 'Advanced'), ENT_QUOTES) ?></button>
    </div>

    <!-- Language selector -->
    <div class="lang-group">
      <span class="lang-icon" aria-hidden="true">🌐</span>
      <select id="lang-select" data-i18n-title="lang.tip" data-i18n-aria-label="lang.label"
              title="<?= htmlspecialchars($t('lang.tip', ''), ENT_QUOTES) ?>"
              aria-label="<?= htmlspecialchars($t('lang.label', 'Language'), ENT_QUOTES) ?>">
        <?php foreach ($langs as $code => $name): ?>
          <option value="<?= htmlspecialchars($code, ENT_QUOTES) ?>"<?= $code === $lang ? ' selected' : '' ?>><?= htmlspecialchars($name, ENT_QUOTES) ?></option>
        <?php endforeach; ?>
      </select>
    </div>

    <div class="engine-pill starting" id="engine-status" data-i18n-title="engine.title" title="<?= htmlspecialchars($t('engine.title', 'Engine status'), ENT_QUOTES) ?>">
      <span class="dot"></span><span class="txt" data-i18n="engine.connecting"><?= htmlspecialchars($t('engine.connecting', 'connecting…'), ENT_QUOTES) ?></span>
    </div>
  </header>

  <!-- friendly connectivity banner -->
  <div class="banner" id="banner" role="status" aria-live="polite">
    <span class="spinner" id="banner-spinner"></span>
    <span id="banner-text"></span>
  </div>

  <!-- model-download bar: shown while a preset's model is downloading on first use -->
  <div class="model-bar hidden" id="model-bar" role="status" aria-live="polite">
    <div class="model-bar-row">
      <span class="spinner"></span>
      <span class="model-bar-text" id="model-bar-text" data-i18n="model.downloading"><?= htmlspecialchars($t('model.downloading', 'Downloading model… (first use of this preset)'), ENT_QUOTES) ?></span>
      <span class="model-bar-elapsed" id="model-bar-elapsed" title="<?= htmlspecialchars($t('model.elapsed', 'Elapsed'), ENT_QUOTES) ?>" data-i18n-title="model.elapsed">00:00</span>
    </div>
    <div class="model-bar-track"><div class="model-bar-fill" id="model-bar-fill"></div></div>
  </div>

  <!-- ======================= APP GRID ======================= -->
  <main class="app">

    <!-- ============ LEFT COLUMN: controls ============ -->
    <section class="left-col">

      <!-- Core generation -->
      <div class="card">
        <div class="card-body">
          <label class="field">
            <span class="lbl" data-i18n="field.prompt"><?= htmlspecialchars($t('field.prompt', 'Positive prompt'), ENT_QUOTES) ?></span>
            <textarea id="prompt" class="prompt-area" data-i18n-placeholder="field.prompt.ph" placeholder="<?= htmlspecialchars($t('field.prompt.ph', ''), ENT_QUOTES) ?>"></textarea>
          </label>

          <label class="field">
            <span class="lbl" data-i18n="field.negative"><?= htmlspecialchars($t('field.negative', 'Negative prompt'), ENT_QUOTES) ?></span>
            <textarea id="negative_prompt" class="neg-area" data-i18n-placeholder="field.negative.ph" placeholder="<?= htmlspecialchars($t('field.negative.ph', ''), ENT_QUOTES) ?>"></textarea>
          </label>
        </div>
      </div>

      <!-- Image-input tabs (advanced only) — the prominent MAIN box -->
      <div class="card adv-only input-tabs-card">
        <div class="tabs" id="input-tabs" role="tablist">
          <button class="tab active" data-tab="text"     role="tab" data-i18n="tab.text"><?= htmlspecialchars($t('tab.text', 'Text to Image'), ENT_QUOTES) ?></button>
          <button class="tab" data-tab="uov"      role="tab" data-i18n="tab.uov"><?= htmlspecialchars($t('tab.uov', 'Upscale / Vary'), ENT_QUOTES) ?></button>
          <button class="tab" data-tab="ip"       role="tab" data-i18n="tab.ip"><?= htmlspecialchars($t('tab.ip', 'Image Prompt'), ENT_QUOTES) ?></button>
          <button class="tab" data-tab="inpaint"  role="tab" data-i18n="tab.inpaint"><?= htmlspecialchars($t('tab.inpaint', 'Inpaint / Outpaint'), ENT_QUOTES) ?></button>
          <button class="tab" data-tab="describe" role="tab" data-i18n="tab.describe"><?= htmlspecialchars($t('tab.describe', 'Describe'), ENT_QUOTES) ?></button>
          <button class="tab" data-tab="enhance"  role="tab" data-i18n="tab.enhance"><?= htmlspecialchars($t('tab.enhance', 'Enhance'), ENT_QUOTES) ?></button>
          <button class="tab" data-tab="metadata" role="tab" data-i18n="tab.metadata"><?= htmlspecialchars($t('tab.metadata', 'Metadata'), ENT_QUOTES) ?></button>
        </div>

        <!-- Text to image (default) -->
        <div class="tabpanel active" data-panel="text">
          <p class="muted" style="margin:0" data-i18n="panel.text.desc"><?= htmlspecialchars($t('panel.text.desc', ''), ENT_QUOTES) ?></p>
        </div>

        <!-- Upscale / Vary -->
        <div class="tabpanel" data-panel="uov">
          <label class="field">
            <span class="lbl" data-i18n="uov.mode"><?= htmlspecialchars($t('uov.mode', 'Mode'), ENT_QUOTES) ?></span>
            <select id="uov_method">
              <option value="Disabled" data-i18n="uov.disabled"><?= htmlspecialchars($t('uov.disabled', 'Disabled'), ENT_QUOTES) ?></option>
              <option value="Vary (Subtle)" data-i18n="uov.vary.subtle"><?= htmlspecialchars($t('uov.vary.subtle', 'Vary (Subtle)'), ENT_QUOTES) ?></option>
              <option value="Vary (Strong)" data-i18n="uov.vary.strong"><?= htmlspecialchars($t('uov.vary.strong', 'Vary (Strong)'), ENT_QUOTES) ?></option>
              <option value="Upscale (1.5x)" data-i18n="uov.up.15"><?= htmlspecialchars($t('uov.up.15', 'Upscale (1.5x)'), ENT_QUOTES) ?></option>
              <option value="Upscale (2x)" data-i18n="uov.up.2"><?= htmlspecialchars($t('uov.up.2', 'Upscale (2x)'), ENT_QUOTES) ?></option>
              <option value="Upscale (Fast 2x)" data-i18n="uov.up.fast2"><?= htmlspecialchars($t('uov.up.fast2', 'Upscale (Fast 2x)'), ENT_QUOTES) ?></option>
            </select>
          </label>
          <div class="dropzone" data-drop="uov_image"><div class="icon">⬆️</div><div data-i18n="uov.drop"><?= htmlspecialchars($t('uov.drop', ''), ENT_QUOTES) ?></div></div>
          <input type="file" accept="image/*" class="hidden" data-file="uov_image">
          <p class="note" data-i18n="uov.note"><?= htmlspecialchars($t('uov.note', ''), ENT_QUOTES) ?></p>
        </div>

        <!-- Image Prompt -->
        <div class="tabpanel" data-panel="ip">
          <div class="dropzone" data-drop="ip_image"><div class="icon">🖼️</div><div data-i18n="ip.drop"><?= htmlspecialchars($t('ip.drop', ''), ENT_QUOTES) ?></div></div>
          <input type="file" accept="image/*" class="hidden" data-file="ip_image">
          <div class="row cols-2" style="margin-top:12px">
            <label class="field"><span class="lbl" data-i18n="ip.type"><?= htmlspecialchars($t('ip.type', 'Type'), ENT_QUOTES) ?></span>
              <select id="ip_type"><option>ImagePrompt</option><option>PyraCanny</option><option>CPDS</option><option>FaceSwap</option></select>
            </label>
            <label class="field"><span class="field-label"><span data-i18n="ip.weight"><?= htmlspecialchars($t('ip.weight', 'Weight'), ENT_QUOTES) ?></span><span class="val" data-out="ip_weight">0.60</span></span>
              <input type="range" id="ip_weight" min="0" max="2" step="0.05" value="0.6">
            </label>
          </div>
          <p class="note" data-i18n="ip.note"><?= htmlspecialchars($t('ip.note', ''), ENT_QUOTES) ?></p>
        </div>

        <!-- Inpaint / Outpaint -->
        <div class="tabpanel" data-panel="inpaint">
          <!-- upload / drop zone (hidden once an image is loaded) -->
          <div class="dropzone" id="inpaint-dropzone"><div class="icon">🎨</div><div data-i18n="inpaint.upload"><?= htmlspecialchars($t('inpaint.upload', 'Drop or click to upload the image to edit'), ENT_QUOTES) ?></div></div>
          <input type="file" accept="image/*" class="hidden" id="inpaint-file">

          <!-- mask editor: source image on a canvas with a translucent paint overlay -->
          <div class="inpaint-editor hidden" id="inpaint-editor">
            <div class="inpaint-canvas-wrap" id="inpaint-canvas-wrap">
              <canvas id="inpaint-canvas"></canvas>
            </div>
            <p class="note" data-i18n="inpaint.canvas_hint"><?= htmlspecialchars($t('inpaint.canvas_hint', ''), ENT_QUOTES) ?></p>

            <div class="inpaint-tools">
              <label class="field" style="margin:0;flex:1 1 180px">
                <span class="field-label"><span data-i18n="inpaint.brush_size"><?= htmlspecialchars($t('inpaint.brush_size', 'Brush size'), ENT_QUOTES) ?></span><span class="val" id="inpaint-brush-out">40</span></span>
                <input type="range" id="inpaint-brush" min="4" max="160" step="2" value="40">
              </label>
              <div class="inpaint-tool-btns">
                <button type="button" class="btn sm inpaint-tool active" id="inpaint-brush-btn" aria-pressed="true" data-i18n="inpaint.brush"><?= htmlspecialchars($t('inpaint.brush', 'Brush'), ENT_QUOTES) ?></button>
                <button type="button" class="btn sm inpaint-tool" id="inpaint-erase-btn" aria-pressed="false" data-i18n="inpaint.erase"><?= htmlspecialchars($t('inpaint.erase', 'Eraser'), ENT_QUOTES) ?></button>
                <button type="button" class="btn ghost sm" id="inpaint-clear-btn" data-i18n="inpaint.clear"><?= htmlspecialchars($t('inpaint.clear', 'Clear mask'), ENT_QUOTES) ?></button>
              </div>
            </div>
          </div>

          <label class="field" style="margin-top:12px"><span class="lbl" data-i18n="inpaint.mode"><?= htmlspecialchars($t('inpaint.mode', 'Inpaint mode'), ENT_QUOTES) ?></span>
            <select id="inpaint_mode">
              <option data-i18n="inpaint.mode.default"><?= htmlspecialchars($t('inpaint.mode.default', ''), ENT_QUOTES) ?></option>
              <option data-i18n="inpaint.mode.detail"><?= htmlspecialchars($t('inpaint.mode.detail', ''), ENT_QUOTES) ?></option>
              <option data-i18n="inpaint.mode.content"><?= htmlspecialchars($t('inpaint.mode.content', ''), ENT_QUOTES) ?></option>
            </select>
          </label>
          <p class="note" data-i18n="inpaint.note"><?= htmlspecialchars($t('inpaint.note', ''), ENT_QUOTES) ?></p>
        </div>

        <!-- Describe -->
        <div class="tabpanel" data-panel="describe">
          <div class="dropzone" data-drop="describe_image"><div class="icon">🔍</div><div data-i18n="describe.drop"><?= htmlspecialchars($t('describe.drop', ''), ENT_QUOTES) ?></div></div>
          <input type="file" accept="image/*" class="hidden" data-file="describe_image">
          <label class="field" style="margin-top:12px"><span class="lbl" data-i18n="describe.type"><?= htmlspecialchars($t('describe.type', 'Content type'), ENT_QUOTES) ?></span>
            <select id="describe_type"><option data-i18n="describe.type.photo"><?= htmlspecialchars($t('describe.type.photo', 'Photograph'), ENT_QUOTES) ?></option><option data-i18n="describe.type.art"><?= htmlspecialchars($t('describe.type.art', 'Art/Anime'), ENT_QUOTES) ?></option></select>
          </label>
          <button class="btn block" id="btn-describe" style="margin-top:6px" disabled data-i18n="describe.btn"><?= htmlspecialchars($t('describe.btn', 'Describe image'), ENT_QUOTES) ?></button>
          <p class="note" data-i18n="describe.note"><?= htmlspecialchars($t('describe.note', ''), ENT_QUOTES) ?></p>
        </div>

        <!-- Enhance -->
        <div class="tabpanel" data-panel="enhance">
          <label class="check"><input type="checkbox" id="enhance_enabled"> <span data-i18n="enhance.enable"><?= htmlspecialchars($t('enhance.enable', ''), ENT_QUOTES) ?></span></label>
          <p class="note" data-i18n="enhance.note"><?= htmlspecialchars($t('enhance.note', ''), ENT_QUOTES) ?></p>
        </div>

        <!-- Metadata -->
        <div class="tabpanel" data-panel="metadata">
          <div class="dropzone" data-drop="metadata_image"><div class="icon">🧾</div><div data-i18n="metadata.drop"><?= htmlspecialchars($t('metadata.drop', ''), ENT_QUOTES) ?></div></div>
          <input type="file" accept="image/*" class="hidden" data-file="metadata_image">
          <pre id="metadata_out" class="status" style="display:none;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:12px;white-space:pre-wrap;font-family:var(--mono);font-size:12px;margin-top:12px"></pre>
          <p class="note" data-i18n="metadata.note"><?= htmlspecialchars($t('metadata.note', ''), ENT_QUOTES) ?></p>
        </div>
      </div>

      <!-- Generate / Stop / Skip — directly below the main (tabs) box.
           Always visible (NOT adv-only): in Simple mode the tabs box above is
           hidden, so the order collapses to prompt → Generate. -->
      <div class="gen-buttons">
        <button class="btn primary lg" id="btn-generate"><span class="ico">✨</span><span class="txt" data-i18n="btn.generate"><?= htmlspecialchars($t('btn.generate', 'Generate'), ENT_QUOTES) ?></span></button>
        <button class="btn ghost adv-only" id="btn-skip" disabled data-i18n="btn.skip"><?= htmlspecialchars($t('btn.skip', 'Skip'), ENT_QUOTES) ?></button>
        <button class="btn danger" id="btn-stop" disabled data-i18n="btn.stop"><?= htmlspecialchars($t('btn.stop', 'Stop'), ENT_QUOTES) ?></button>
      </div>

      <!-- Performance (collapsed by default) -->
      <div class="card">
        <details class="collapsible" id="performance-section">
          <summary data-i18n="field.performance"><?= htmlspecialchars($t('field.performance', 'Performance'), ENT_QUOTES) ?></summary>
          <div class="card-body">
            <div class="seg" id="performance" role="radiogroup" data-i18n-aria-label="field.performance" aria-label="<?= htmlspecialchars($t('field.performance', 'Performance'), ENT_QUOTES) ?>"></div>
          </div>
        </details>
      </div>

      <!-- Setting basics -->
      <div class="card">
        <div class="card-body">
          <div class="adv-only">
            <label class="field"><span class="lbl" data-i18n="field.output_format"><?= htmlspecialchars($t('field.output_format', 'Output format'), ENT_QUOTES) ?></span>
              <select id="output_format"></select>
            </label>
          </div>

          <div style="margin-top:4px">
            <span class="field-label"><span data-i18n="field.aspect_ratio"><?= htmlspecialchars($t('field.aspect_ratio', 'Aspect ratio'), ENT_QUOTES) ?></span></span>
            <select id="aspect_ratio" data-i18n-aria-label="field.aspect_ratio" aria-label="<?= htmlspecialchars($t('field.aspect_ratio', 'Aspect ratio'), ENT_QUOTES) ?>"></select>
          </div>

          <div class="row cols-2" style="margin-top:14px">
            <label class="field"><span class="field-label"><span data-i18n="field.image_number"><?= htmlspecialchars($t('field.image_number', 'Image number'), ENT_QUOTES) ?></span><span class="val" data-out="image_number">1</span></span>
              <input type="range" id="image_number" min="1" max="32" step="1" value="1">
            </label>
            <div>
              <span class="field-label"><span data-i18n="field.seed"><?= htmlspecialchars($t('field.seed', 'Seed'), ENT_QUOTES) ?></span></span>
              <label class="check" style="margin-bottom:6px"><input type="checkbox" id="seed_random" checked> <span data-i18n="field.seed.random"><?= htmlspecialchars($t('field.seed.random', 'Random'), ENT_QUOTES) ?></span></label>
              <input type="number" id="seed" value="-1" disabled>
            </div>
          </div>
        </div>
      </div>

      <!-- Styles -->
      <div class="card">
        <div class="card-body">
          <div class="section-title" data-i18n="section.styles"><?= htmlspecialchars($t('section.styles', 'Styles'), ENT_QUOTES) ?></div>
          <div class="styles-box">
            <input type="search" class="styles-search" id="style-search" data-i18n-placeholder="styles.search.ph" placeholder="<?= htmlspecialchars($t('styles.search.ph', 'Search styles…'), ENT_QUOTES) ?>">
            <div class="styles-list" id="styles-list"></div>
            <div class="styles-meta">
              <span><span id="styles-count">0</span> <span data-i18n="styles.selected"><?= htmlspecialchars($t('styles.selected', 'selected'), ENT_QUOTES) ?></span></span>
              <a id="styles-clear" data-i18n="styles.clear"><?= htmlspecialchars($t('styles.clear', 'Clear all'), ENT_QUOTES) ?></a>
            </div>
          </div>
        </div>
      </div>

      <!-- Models (advanced only) -->
      <div class="card adv-only">
        <div class="card-body">
          <div class="section-title" data-i18n="section.models"><?= htmlspecialchars($t('section.models', 'Models'), ENT_QUOTES) ?></div>
          <label class="field"><span class="lbl" data-i18n="field.base_model"><?= htmlspecialchars($t('field.base_model', 'Base model (checkpoint)'), ENT_QUOTES) ?></span>
            <select id="base_model"></select>
          </label>
          <div class="row cols-2">
            <label class="field"><span class="lbl" data-i18n="field.refiner"><?= htmlspecialchars($t('field.refiner', 'Refiner'), ENT_QUOTES) ?></span>
              <select id="refiner_model"></select>
            </label>
            <label class="field"><span class="field-label"><span data-i18n="field.refiner_switch"><?= htmlspecialchars($t('field.refiner_switch', 'Refiner switch'), ENT_QUOTES) ?></span><span class="val" data-out="refiner_switch">0.50</span></span>
              <input type="range" id="refiner_switch" min="0.1" max="1" step="0.01" value="0.5">
            </label>
          </div>

          <div class="section-title" style="margin-top:8px" data-i18n="section.loras"><?= htmlspecialchars($t('section.loras', 'LoRAs'), ENT_QUOTES) ?></div>
          <div id="lora-rows"><!-- 5 rows injected by JS --></div>
        </div>
      </div>

      <!-- Advanced (advanced only) -->
      <div class="card adv-only">
        <details class="collapsible" id="advanced">
          <summary data-i18n="section.advanced"><?= htmlspecialchars($t('section.advanced', 'Advanced'), ENT_QUOTES) ?></summary>
          <div class="card-body">
            <div class="row cols-2">
              <label class="field"><span class="field-label"><span data-i18n="field.guidance_scale"><?= htmlspecialchars($t('field.guidance_scale', 'Guidance Scale (CFG)'), ENT_QUOTES) ?></span><span class="val" data-out="guidance_scale">4.0</span></span>
                <input type="range" id="guidance_scale" min="1" max="30" step="0.1" value="4">
              </label>
              <label class="field"><span class="field-label"><span data-i18n="field.sharpness"><?= htmlspecialchars($t('field.sharpness', 'Image Sharpness'), ENT_QUOTES) ?></span><span class="val" data-out="sharpness">2.0</span></span>
                <input type="range" id="sharpness" min="0" max="30" step="0.1" value="2">
              </label>
            </div>
            <div class="row cols-2">
              <label class="field"><span class="lbl" data-i18n="field.sampler"><?= htmlspecialchars($t('field.sampler', 'Sampler'), ENT_QUOTES) ?></span>
                <select id="sampler"></select>
              </label>
              <label class="field"><span class="lbl" data-i18n="field.scheduler"><?= htmlspecialchars($t('field.scheduler', 'Scheduler'), ENT_QUOTES) ?></span>
                <select id="scheduler"></select>
              </label>
            </div>
            <div class="row cols-3">
              <label class="field"><span class="lbl" data-i18n="field.steps_override"><?= htmlspecialchars($t('field.steps_override', 'Steps override'), ENT_QUOTES) ?></span>
                <input type="number" id="steps_override" value="-1" min="-1" max="200">
                <span class="help" data-i18n="field.steps_override.help"><?= htmlspecialchars($t('field.steps_override.help', ''), ENT_QUOTES) ?></span>
              </label>
              <label class="field"><span class="lbl" data-i18n="field.vae"><?= htmlspecialchars($t('field.vae', 'VAE'), ENT_QUOTES) ?></span>
                <select id="vae"></select>
              </label>
              <label class="field"><span class="field-label"><span data-i18n="field.clip_skip"><?= htmlspecialchars($t('field.clip_skip', 'CLIP skip'), ENT_QUOTES) ?></span><span class="val" data-out="clip_skip">1</span></span>
                <input type="range" id="clip_skip" min="1" max="12" step="1" value="1">
              </label>
            </div>
          </div>
        </details>
      </div>

    </section>

    <!-- ============ RIGHT COLUMN: results ============ -->
    <aside class="right-col">
      <div class="card results" style="position:sticky;top:74px">
        <div class="card-body">
          <div class="section-title" data-i18n="section.results"><?= htmlspecialchars($t('section.results', 'Results'), ENT_QUOTES) ?></div>

          <div class="progress-wrap hidden" id="progress-wrap">
            <div class="progress-track" id="progress-track">
              <div class="progress-bar" id="progress-bar"></div>
            </div>
            <div class="progress-text">
              <span id="progress-msg" data-i18n="progress.waiting"><?= htmlspecialchars($t('progress.waiting', 'Waiting…'), ENT_QUOTES) ?></span>
              <span class="progress-right">
                <span id="progress-elapsed" class="elapsed" title="<?= htmlspecialchars($t('results.elapsed', 'Elapsed'), ENT_QUOTES) ?>" data-i18n-title="results.elapsed">00:00</span>
                <span id="progress-pct">0%</span>
              </span>
            </div>
            <div class="firstrun-note hidden" id="firstrun-note" data-i18n="results.firstrun"><?= htmlspecialchars($t('results.firstrun', ''), ENT_QUOTES) ?></div>
          </div>

          <div class="preview-stage" id="preview-stage">
            <div class="placeholder" id="preview-placeholder">
              <div class="big">🖼️</div>
              <div data-i18n="results.placeholder"><?= htmlspecialchars($t('results.placeholder', ''), ENT_QUOTES) ?></div>
            </div>
            <img id="preview-img" class="hidden" data-i18n-alt="results.preview.alt" alt="<?= htmlspecialchars($t('results.preview.alt', 'Live preview'), ENT_QUOTES) ?>">
          </div>

          <div class="results-feed-head" id="results-feed-head" hidden>
            <span class="results-feed-title">
              <span data-i18n="results.title"><?= htmlspecialchars($t('results.title', 'Results'), ENT_QUOTES) ?></span>
              <span class="results-feed-count">(<span id="results-count">0</span>)</span>
            </span>
            <button type="button" class="btn ghost sm" id="results-clear" data-i18n="results.clear"><?= htmlspecialchars($t('results.clear', 'Clear'), ENT_QUOTES) ?></button>
          </div>
          <div class="gallery results-feed" id="results-feed"></div>
        </div>
      </div>
    </aside>
  </main>

  <!-- lightbox -->
  <div class="lightbox" id="lightbox"><span class="close" id="lightbox-close" data-i18n-title="lightbox.close" title="<?= htmlspecialchars($t('lightbox.close', 'Close'), ENT_QUOTES) ?>">×</span><img id="lightbox-img" data-i18n-alt="lightbox.alt" alt="<?= htmlspecialchars($t('lightbox.alt', 'Full image'), ENT_QUOTES) ?>"></div>

  <footer class="foot">
    <span data-i18n="foot.text"><?= htmlspecialchars($t('foot.text', 'DedrisGenAI · AI Image Studio · '), ENT_QUOTES) ?></span><span id="foot-version">v—</span>
  </footer>

  <!-- LoRA row template -->
  <template id="lora-row-tpl">
    <div class="lora-row">
      <label class="check"><input type="checkbox" class="lora-enabled" checked></label>
      <div class="lw">
        <select class="lora-name"></select>
      </div>
      <div class="lw">
        <span class="field-label"><span data-i18n="field.weight"><?= htmlspecialchars($t('field.weight', 'Weight'), ENT_QUOTES) ?></span><span class="val lora-weight-out">1.00</span></span>
        <input type="range" class="lora-weight" min="-2" max="2" step="0.01" value="1">
      </div>
    </div>
  </template>

  <!-- Style chip template -->
  <template id="style-chip-tpl">
    <button type="button" class="style-card">
      <span class="style-thumb"></span>
      <span class="style-name"></span>
    </button>
  </template>

  <script src="assets/js/app.js?v=<?= $asset_ver('assets/js/app.js') ?>"></script>
</body>
</html>
