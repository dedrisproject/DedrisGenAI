/* DedrisGenAI — Examples / Demo gallery controller
 * Vanilla JS, no framework. Talks only to same-origin /api/* (the PHP proxy).
 *
 * Responsibilities:
 *   - i18n: fetch the dictionary from api/lang and apply data-i18n* attributes,
 *     mirroring the main app so the page is fully translated (English default).
 *   - Fetch GET api/options and render a responsive grid of style cards: each
 *     card shows the style preview image (lazy-loaded, with a tasteful gradient
 *     placeholder when there is none) and the style name.
 *   - Live search filters cards by name.
 *   - "Try this style" hand-off: save the chosen style to localStorage
 *     (dedris.pendingStyle) and navigate to the main app (index.php), which reads
 *     the key on boot and preselects the style. ?style= is also appended as a
 *     fallback so the app can pick it up either way.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  async function api(path, opts = {}) {
    const res = await fetch('api/' + path.replace(/^\/?api\//, '').replace(/^\//, ''), {
      headers: { 'Accept': 'application/json' },
      ...opts,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { _raw: text }; }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  // style previews are served same-origin through the proxy; normalise the path.
  function previewUrl(p) {
    if (!p) return '';
    if (/^(https?:|data:)/.test(p)) return p;
    return p.replace(/^\/+/, ''); // "/styles/x.jpg" -> "styles/x.jpg" (router serves it)
  }

  // ============================================================== i18n
  const LANGS = ['en', 'it', 'de', 'fr', 'es'];
  const DEFAULT_LANG = (document.documentElement.dataset.defaultLang) || 'en';
  const LS_LANG = 'dedris.lang';
  const LS_PENDING_STYLE = 'dedris.pendingStyle';

  const i18n = { lang: DEFAULT_LANG, dict: {}, cache: {} };

  function t(key, vars) {
    let s = (i18n.dict && i18n.dict[key]);
    if (s == null) s = key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
    return s;
  }

  function pickInitialLang() {
    try {
      const saved = localStorage.getItem(LS_LANG);
      if (saved && LANGS.includes(saved)) return saved;
    } catch (_) { /* ignore */ }
    const nav = (navigator.language || navigator.userLanguage || DEFAULT_LANG).slice(0, 2).toLowerCase();
    return LANGS.includes(nav) ? nav : DEFAULT_LANG;
  }

  async function loadDict(lang) {
    if (i18n.cache[lang]) return i18n.cache[lang];
    let dict;
    try {
      dict = await api('lang?code=' + encodeURIComponent(lang));
    } catch (e) {
      try {
        const res = await fetch('../i18n/' + lang + '.json', { headers: { Accept: 'application/json' } });
        dict = res.ok ? await res.json() : null;
      } catch (_) { dict = null; }
    }
    if (!dict || typeof dict !== 'object') dict = i18n.cache[DEFAULT_LANG] || {};
    i18n.cache[lang] = dict;
    return dict;
  }

  function applyTranslations(root = document) {
    $$('[data-i18n]', root).forEach((n) => { n.textContent = t(n.getAttribute('data-i18n')); });
    $$('[data-i18n-placeholder]', root).forEach((n) => { n.setAttribute('placeholder', t(n.getAttribute('data-i18n-placeholder'))); });
    $$('[data-i18n-title]', root).forEach((n) => { n.setAttribute('title', t(n.getAttribute('data-i18n-title'))); });
    $$('[data-i18n-aria-label]', root).forEach((n) => { n.setAttribute('aria-label', t(n.getAttribute('data-i18n-aria-label'))); });
    $$('[data-i18n-alt]', root).forEach((n) => { n.setAttribute('alt', t(n.getAttribute('data-i18n-alt'))); });
    document.documentElement.setAttribute('lang', i18n.lang);
    document.documentElement.setAttribute('dir', t('_meta.dir') === 'rtl' ? 'rtl' : 'ltr');
  }

  async function setLanguage(lang, persist = true) {
    if (!LANGS.includes(lang)) lang = DEFAULT_LANG;
    i18n.lang = lang;
    i18n.dict = await loadDict(lang);
    if (persist) { try { localStorage.setItem(LS_LANG, lang); } catch (_) {} }
    const sel = $('#lang-select');
    if (sel && sel.value !== lang) sel.value = lang;
    applyTranslations();
    renderGrid($('#demo-search') ? $('#demo-search').value : '');
  }

  // ============================================================== styles
  const STYLE_GRADS = [
    ['#7c5cff', '#3aa0ff'], ['#22d3ee', '#3aa0ff'], ['#f472b6', '#7c5cff'],
    ['#34d399', '#22d3ee'], ['#fbbf24', '#f87171'], ['#60a5fa', '#a78bfa'],
    ['#f97316', '#ef4444'], ['#10b981', '#3b82f6'],
  ];
  function styleInitials(name) {
    const words = String(name).replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  function gradFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return STYLE_GRADS[h % STYLE_GRADS.length];
  }

  const state = { styles: [] };

  // "Try this style" hand-off: persist the chosen style and open the main app.
  function tryStyle(name) {
    try { localStorage.setItem(LS_PENDING_STYLE, name); } catch (_) {}
    // Also pass it as a query param so the app can pick it up either way.
    window.location.href = 'index.php?style=' + encodeURIComponent(name);
  }

  function renderGrid(filter = '') {
    const grid = $('#demo-grid');
    const status = $('#demo-status');
    const tpl = $('#demo-card-tpl');
    if (!grid || !tpl) return;
    grid.innerHTML = '';

    const f = filter.trim().toLowerCase();
    const matches = state.styles.filter((s) => !f || s.name.toLowerCase().includes(f));

    if (!matches.length) {
      grid.hidden = true;
      if (status) { status.hidden = false; status.classList.remove('error'); status.textContent = t('demo.empty'); }
      return;
    }
    if (status) status.hidden = true;
    grid.hidden = false;

    matches.forEach((s) => {
      const card = tpl.content.firstElementChild.cloneNode(true);
      const thumb = $('.demo-thumb', card);
      if (s.preview) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = t('styles.preview.alt', { name: s.name });
        img.src = previewUrl(s.preview);
        // fall back to a gradient placeholder if the preview fails to load
        img.addEventListener('error', () => { paintPlaceholder(thumb, s.name); });
        thumb.appendChild(img);
      } else {
        paintPlaceholder(thumb, s.name);
      }
      $('.demo-name', card).textContent = s.name;
      card.setAttribute('title', s.name);
      const btn = $('.demo-try', card);
      btn.textContent = t('demo.try');
      btn.addEventListener('click', () => tryStyle(s.name));
      grid.appendChild(card);
    });
  }

  function paintPlaceholder(thumb, name) {
    thumb.innerHTML = '';
    const g = gradFor(name);
    thumb.classList.add('placeholder');
    thumb.style.background = 'linear-gradient(135deg,' + g[0] + ',' + g[1] + ')';
    thumb.textContent = styleInitials(name);
  }

  // ============================================================== boot
  async function boot() {
    await setLanguage(pickInitialLang(), false);

    const langSel = $('#lang-select');
    if (langSel) langSel.addEventListener('change', (e) => setLanguage(e.target.value));

    const search = $('#demo-search');
    if (search) search.addEventListener('input', (e) => renderGrid(e.target.value));

    // version in the footer (best-effort)
    api('health').then((h) => {
      if (h && h.version) { const v = $('#foot-version'); if (v) v.textContent = 'v' + h.version; }
    }).catch(() => { /* ignore */ });

    try {
      const opts = await api('options');
      const raw = (opts && opts.styles) || [];
      state.styles = raw.map((s) => (typeof s === 'string' ? { name: s, preview: null } : s));
      renderGrid('');
    } catch (e) {
      console.warn('options load failed', e);
      const status = $('#demo-status');
      const grid = $('#demo-grid');
      if (grid) grid.hidden = true;
      if (status) { status.hidden = false; status.classList.add('error'); status.textContent = t('demo.error'); }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
