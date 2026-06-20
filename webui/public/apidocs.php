<?php
/**
 * DedrisGenAI — API documentation page (standalone, interactive).
 *
 * A self-contained developer reference for the same-origin PHP proxy API
 * (webui/api/*). It renders one card per endpoint with an HTTP method badge,
 * the path, a short description, the params/body, a ready-to-copy curl snippet
 * and a "Run" button that executes the call from the browser and shows the
 * pretty-printed JSON response inline.
 *
 * All calls are same-origin: the curl snippets and the Run requests are built
 * against window.location.origin (the page's own origin), which is exactly the
 * proxy prefix the browser already uses. The engine is never contacted directly.
 *
 * It reuses the app's stylesheet, dark theme and i18n exactly like demo.php; the
 * dictionary is fetched from api/lang and applied to data-i18n* nodes on load.
 * Endpoint cards themselves are rendered by assets/js/apidocs.js.
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
  <title data-i18n="api.title"><?= htmlspecialchars($t('api.title', 'API'), ENT_QUOTES) ?></title>
  <meta name="description" content="DedrisGenAI — Interactive API reference for the same-origin proxy.">
  <link rel="icon" type="image/svg+xml" href="assets/img/logo.svg">
  <link rel="stylesheet" href="assets/css/style.css?v=<?= $asset_ver('assets/css/style.css') ?>">
  <script>
    /* Apply persisted language as early as possible to avoid a flash. */
    (function () {
      try {
        var supported = <?= json_encode(array_keys($langs), JSON_UNESCAPED_SLASHES) ?>;
        var def = <?= json_encode(Lang::DEFAULT) ?>;
        var lang = localStorage.getItem('dedris.lang');
        if (!lang || supported.indexOf(lang) === -1) {
          var nav = (navigator.language || navigator.userLanguage || def).slice(0, 2).toLowerCase();
          lang = supported.indexOf(nav) !== -1 ? nav : def;
        }
        document.documentElement.setAttribute('lang', lang);
      } catch (e) { /* ignore */ }
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

    <!-- Back to the main app -->
    <a class="btn ghost sm" id="back-to-app" href="index.php"
       data-i18n="api.back"><?= htmlspecialchars($t('api.back', '← Back to app'), ENT_QUOTES) ?></a>
  </header>

  <!-- ======================= API REFERENCE ======================= -->
  <main class="api-wrap">
    <div class="api-head">
      <h1 data-i18n="api.title"><?= htmlspecialchars($t('api.title', 'API'), ENT_QUOTES) ?></h1>
      <p data-i18n="api.intro"><?= htmlspecialchars($t('api.intro', 'Every endpoint below is reachable on this site at the same origin. Calls go through the DedrisGenAI PHP proxy — your browser never talks to the engine directly. Copy a ready-made curl snippet, or hit Run to try it from your browser.'), ENT_QUOTES) ?></p>

      <!-- Base URL = the page's own origin (filled by JS as window.location.origin). -->
      <div class="api-baseurl">
        <span class="api-baseurl-label" data-i18n="api.baseurl"><?= htmlspecialchars($t('api.baseurl', 'Base URL'), ENT_QUOTES) ?></span>
        <code class="api-baseurl-val" id="api-baseurl">…</code>
        <button type="button" class="btn ghost sm api-baseurl-copy" id="api-baseurl-copy" data-i18n="api.copy"><?= htmlspecialchars($t('api.copy', 'Copy'), ENT_QUOTES) ?></button>
      </div>
    </div>

    <!-- Endpoint sections + cards are rendered here by assets/js/apidocs.js. -->
    <div class="api-sections" id="api-sections"></div>
  </main>

  <footer class="foot">
    <span data-i18n="foot.text"><?= htmlspecialchars($t('foot.text', 'DedrisGenAI · AI Image Studio · '), ENT_QUOTES) ?></span><span id="foot-version">v—</span>
  </footer>

  <!-- Endpoint card template -->
  <template id="api-card-tpl">
    <div class="api-card">
      <div class="api-card-head">
        <span class="api-method"></span>
        <code class="api-path"></code>
        <span class="api-mutating" hidden>⚠︎ mutating</span>
      </div>
      <p class="api-desc"></p>
      <div class="api-params" hidden></div>
      <label class="api-body-field" hidden>
        <span class="api-body-label" data-i18n="api.body"><?= htmlspecialchars($t('api.body', 'Request body (JSON)'), ENT_QUOTES) ?></span>
        <textarea class="api-body" spellcheck="false" rows="6"></textarea>
      </label>
      <div class="api-snippet-wrap">
        <pre class="api-snippet"><code class="api-snippet-code"></code></pre>
        <button type="button" class="btn ghost sm api-copy" data-i18n="api.copy"><?= htmlspecialchars($t('api.copy', 'Copy'), ENT_QUOTES) ?></button>
      </div>
      <div class="api-actions">
        <button type="button" class="btn primary sm api-run" data-i18n="api.run"><?= htmlspecialchars($t('api.run', 'Run'), ENT_QUOTES) ?></button>
      </div>
      <div class="api-result" hidden>
        <div class="api-result-head">
          <span data-i18n="api.response"><?= htmlspecialchars($t('api.response', 'Response'), ENT_QUOTES) ?></span>
          <span class="api-status"></span>
        </div>
        <pre class="api-result-body"><code></code></pre>
      </div>
    </div>
  </template>

  <script src="assets/js/apidocs.js?v=<?= $asset_ver('assets/js/apidocs.js') ?>"></script>
</body>
</html>
