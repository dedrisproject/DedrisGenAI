<?php
/**
 * DedrisGenAI — Examples / Demo page (standalone style gallery).
 *
 * A self-contained page that showcases the built-in style sample images. It
 * fetches GET api/options (same-origin, via the proxy) and renders a responsive
 * grid of style cards (preview image + name). Each card has a "Try this style"
 * action that saves the chosen style name to localStorage (dedris.pendingStyle)
 * and navigates to the main app (index.php), where app.js boot() reads the key
 * and preselects that style. A ?style= query param is also wired as a fallback.
 *
 * It reuses the app's stylesheet, dark theme and i18n exactly like index.php; the
 * dictionary is fetched from api/lang and applied to data-i18n* nodes on load.
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
  <title data-i18n="demo.title"><?= htmlspecialchars($t('demo.title', 'Examples — Style gallery'), ENT_QUOTES) ?></title>
  <meta name="description" content="DedrisGenAI — Showcase of the styles and looks you can generate.">
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

    <!-- API docs page link — opens the standalone interactive API reference. -->
    <a class="icon-btn nav-demo" id="nav-api" href="apidocs.php"
       data-i18n-title="nav.api" data-i18n-aria-label="nav.api"
       title="<?= htmlspecialchars($t('nav.api', 'API'), ENT_QUOTES) ?>"
       aria-label="<?= htmlspecialchars($t('nav.api', 'API'), ENT_QUOTES) ?>"><span aria-hidden="true">⟨⟩</span><span class="nav-demo-txt hidden-sm" data-i18n="nav.api"><?= htmlspecialchars($t('nav.api', 'API'), ENT_QUOTES) ?></span></a>

    <!-- Back to the main app -->
    <a class="btn ghost sm" id="back-to-app" href="index.php"
       data-i18n="demo.back"><?= htmlspecialchars($t('demo.back', '← Back to app'), ENT_QUOTES) ?></a>
  </header>

  <!-- ======================= GALLERY ======================= -->
  <main class="demo-wrap">
    <div class="demo-head">
      <h1 data-i18n="demo.title"><?= htmlspecialchars($t('demo.title', 'Examples — Style gallery'), ENT_QUOTES) ?></h1>
      <p data-i18n="demo.intro"><?= htmlspecialchars($t('demo.intro', 'These samples showcase the styles and looks DedrisGenAI can produce. Pick one you like and click “Try this style” to open the studio with it preselected.'), ENT_QUOTES) ?></p>
    </div>

    <div class="demo-toolbar">
      <input type="search" id="demo-search" data-i18n-placeholder="demo.search.ph"
             placeholder="<?= htmlspecialchars($t('demo.search.ph', 'Search styles…'), ENT_QUOTES) ?>">
    </div>

    <div class="demo-status" id="demo-status" data-i18n="demo.loading"><?= htmlspecialchars($t('demo.loading', 'Loading styles…'), ENT_QUOTES) ?></div>
    <div class="demo-grid" id="demo-grid" hidden></div>
  </main>

  <footer class="foot">
    <span data-i18n="foot.text"><?= htmlspecialchars($t('foot.text', 'DedrisGenAI · AI Image Studio · '), ENT_QUOTES) ?></span><span id="foot-version">v—</span>
  </footer>

  <!-- Style card template -->
  <template id="demo-card-tpl">
    <div class="demo-card">
      <span class="demo-thumb"></span>
      <div class="demo-card-body">
        <div class="demo-name"></div>
        <button type="button" class="btn primary sm demo-try" data-i18n="demo.try">Try this style</button>
      </div>
    </div>
  </template>

  <script src="assets/js/demo.js?v=<?= $asset_ver('assets/js/demo.js') ?>"></script>
</body>
</html>
