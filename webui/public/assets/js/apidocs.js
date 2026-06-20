/* DedrisGenAI — Interactive API reference controller
 * Vanilla JS, no framework. Talks only to same-origin /api/* (the PHP proxy).
 *
 * Responsibilities:
 *   - i18n: fetch the dictionary from api/lang and apply data-i18n* attributes,
 *     mirroring the main app so the page chrome is fully translated (English
 *     default). Endpoint descriptions stay in English (standard for API docs).
 *   - Show the Base URL = the page's own origin (window.location.origin); all
 *     calls go through this same-origin PHP proxy, never to the engine directly.
 *   - Render one card per documented endpoint, grouped into sections, each with:
 *       a coloured HTTP method badge, the path, a one-line description, the
 *       params/body, a copyable curl snippet (built from the live origin) and a
 *       Run button.
 *   - Copy: clipboard with a textarea fallback and a "Copied" flash.
 *   - Run: GET fires immediately; POST validates the editable JSON body first,
 *     then sends it. The status code + pretty-printed JSON response is shown in a
 *     result area under the card. Engine-unreachable (503) is handled gracefully.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // The page origin — every call and every snippet is built against this.
  const ORIGIN = window.location.origin;

  // ============================================================== i18n
  const LANGS = ['en', 'it', 'de', 'fr', 'es'];
  const DEFAULT_LANG = (document.documentElement.dataset.defaultLang) || 'en';
  const LS_LANG = 'dedris.lang';

  const i18n = { lang: DEFAULT_LANG, dict: {}, cache: {} };

  function t(key, vars) {
    let s = (i18n.dict && i18n.dict[key]);
    if (s == null) s = key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
    return s;
  }

  // Talk to the same-origin proxy. Returns { ok, status, data, raw, binary }.
  async function apiRaw(path, opts = {}) {
    const clean = String(path).replace(/^\/?api\//, '').replace(/^\//, '');
    const res = await fetch('api/' + clean, {
      headers: { Accept: 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    const ctype = res.headers.get('content-type') || '';
    const binary = !/json|text|javascript|xml/i.test(ctype);
    let raw = '';
    let data = null;
    if (!binary) {
      raw = await res.text();
      try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
    }
    return { ok: res.ok, status: res.status, data, raw, binary, ctype };
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
    let dict = null;
    try {
      const r = await apiRaw('lang?code=' + encodeURIComponent(lang));
      if (r.ok && r.data) dict = r.data;
    } catch (_) { /* fall through */ }
    if (!dict) {
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
    // Re-apply translatable labels inside the (already-rendered) cards.
    applyTranslations($('#api-sections'));
  }

  // ============================================================== clipboard
  async function copyText(text, btn) {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (_) { ok = false; }
    if (!ok) {
      // Fallback for insecure contexts / older browsers.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (_) { ok = false; }
    }
    if (btn) {
      const label = btn.getAttribute('data-i18n');
      btn.textContent = t('api.copied');
      btn.classList.add('copied');
      window.setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = label ? t(label) : t('api.copy');
      }, 1400);
    }
    return ok;
  }

  // ============================================================== endpoints
  // Descriptions are kept in English on purpose (standard for API docs).
  // Each endpoint: { method, path, query, desc, body, mutating, runnable }.
  const SECTIONS = [
    {
      title: 'Status',
      endpoints: [
        {
          method: 'GET', path: '/api/health',
          desc: 'Engine health and device. Returns { status, version, device, device_name }.',
        },
        {
          method: 'GET', path: '/api/model_status',
          query: { preset: 'Standard' },
          desc: 'Whether a preset’s models are present / downloading / ready. Returns { state, message, done, total, ready, file, file_index, file_count, downloaded_bytes, total_bytes }.',
        },
        {
          method: 'GET', path: '/api/lora_status',
          desc: 'State of the current “add LoRA from URL” download. Returns { state, message, file, downloaded_bytes, total_bytes, lora_name }.',
        },
      ],
    },
    {
      title: 'Options & Presets',
      endpoints: [
        {
          method: 'GET', path: '/api/options',
          desc: 'Everything the UI needs to render: presets, performances, aspect_ratios, samplers, schedulers, output_formats, styles[{name,preview}], models{checkpoints,loras,vaes}.',
        },
        {
          method: 'GET', path: '/api/preset',
          query: { name: 'Standard' },
          desc: 'Default settings for a preset. name = Standard | Anime | Realistic.',
        },
        {
          method: 'GET', path: '/api/estimate',
          query: { performance: 'Speed', image_number: '1', aspect_ratio: '1152*896', steps_override: '-1' },
          desc: 'Generation-time estimate. Returns { device, device_name, steps, seconds_per_image, total_seconds, calibrated, note }.',
        },
        {
          method: 'GET', path: '/api/lang',
          query: { code: 'en' },
          desc: 'UI translation dictionary for a language code (en | it | de | fr | es). Served by the UI, does not proxy the engine.',
        },
      ],
    },
    {
      title: 'Generation',
      endpoints: [
        {
          method: 'POST', path: '/api/generate', mutating: true,
          desc: 'Start a real generation. Returns { task_id, seed }. Then poll GET /api/progress?task_id=<id> for state, progress, preview and result images.',
          body: {
            preset: 'Standard',
            prompt: 'a rabbit in the forest',
            negative_prompt: '',
            performance: 'Speed',
            aspect_ratio: '1152*896',
            image_number: 1,
          },
        },
        {
          method: 'POST', path: '/api/stop', mutating: true,
          desc: 'Cancel the current / queued task.',
          body: { task_id: '<id>' },
        },
        {
          method: 'GET', path: '/api/progress',
          query: { task_id: '<id>' },
          runnable: false,
          desc: 'Poll a task: { state: pending|running|done|error|stopped, progress: 0-100, preview, message, images: ["/outputs/…"] }. Fill in a real task_id from /api/generate.',
        },
      ],
    },
    {
      title: 'Models & LoRA',
      endpoints: [
        {
          method: 'POST', path: '/api/ensure_model', mutating: true,
          desc: 'Start (or report) the download of a preset’s models. Poll GET /api/model_status?preset=… for progress.',
          body: { preset: 'Anime' },
        },
        {
          method: 'POST', path: '/api/add_lora', mutating: true,
          desc: 'Download a LoRA from a CivitAI / direct .safetensors URL into the engine. Poll GET /api/lora_status for progress.',
          body: { url: '<civitai-or-direct-url>', token: '' },
        },
      ],
    },
    {
      title: 'Static assets',
      endpoints: [
        {
          method: 'GET', path: '/outputs/<path>',
          runnable: false, binaryNote: true,
          desc: 'Generated image bytes (binary). Paths come from a finished task’s images[] array.',
        },
        {
          method: 'GET', path: '/styles/samples/<file>',
          runnable: false, binaryNote: true,
          desc: 'Style preview image bytes (binary). Paths come from /api/options styles[].preview.',
        },
      ],
    },
  ];

  // ---------------------------------------------------------------- snippets
  function buildPathWithQuery(ep) {
    let p = ep.path;
    if (ep.query) {
      const qs = Object.keys(ep.query)
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(ep.query[k]))
        .join('&');
      if (qs) p += '?' + qs;
    }
    return p;
  }

  // Build a copy-pastable curl snippet against the live origin.
  function buildCurl(ep, bodyText) {
    const url = ORIGIN + buildPathWithQuery(ep);
    if (ep.method === 'GET') {
      return "curl '" + url + "'";
    }
    // POST: single-quote the URL, send JSON. Inline the (possibly edited) body,
    // collapsed to a single line so it pastes cleanly.
    let body = bodyText;
    try { body = JSON.stringify(JSON.parse(bodyText)); } catch (_) { /* leave as typed */ }
    const safeBody = String(body).replace(/'/g, "'\\''");
    return "curl -X POST '" + url + "' \\\n" +
           "  -H 'Content-Type: application/json' \\\n" +
           "  -d '" + safeBody + "'";
  }

  function prettyJSON(value) {
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
  }

  // ---------------------------------------------------------------- rendering
  function methodClass(m) {
    return 'api-method ' + 'm-' + String(m).toLowerCase();
  }

  function paramsHTML(ep) {
    const rows = [];
    if (ep.query) {
      Object.keys(ep.query).forEach((k) => {
        rows.push('<code>' + escapeHtml(k) + '=' + escapeHtml(String(ep.query[k])) + '</code>');
      });
    }
    if (!rows.length) return '';
    return 'Query: ' + rows.join(' ');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderCard(ep, tpl) {
    const card = tpl.content.firstElementChild.cloneNode(true);

    const badge = $('.api-method', card);
    badge.textContent = ep.method;
    badge.className = methodClass(ep.method);

    $('.api-path', card).textContent = ep.path;

    const mut = $('.api-mutating', card);
    if (ep.mutating) mut.hidden = false; else mut.remove();

    $('.api-desc', card).textContent = ep.desc;

    const params = $('.api-params', card);
    const ph = paramsHTML(ep);
    if (ph) { params.innerHTML = ph; params.hidden = false; } else { params.remove(); }

    // Editable JSON body for POST endpoints.
    const bodyField = $('.api-body-field', card);
    const bodyArea = $('.api-body', card);
    if (ep.method === 'POST' && ep.body) {
      bodyArea.value = prettyJSON(ep.body);
      bodyField.hidden = false;
    } else {
      bodyField.remove();
    }

    // curl snippet (rebuilt whenever the body textarea changes).
    const codeEl = $('.api-snippet-code', card);
    const refreshSnippet = () => {
      codeEl.textContent = buildCurl(ep, bodyArea ? bodyArea.value : '');
    };
    refreshSnippet();
    if (ep.method === 'POST' && ep.body && bodyArea) {
      bodyArea.addEventListener('input', refreshSnippet);
    }

    // Copy snippet.
    $('.api-copy', card).addEventListener('click', (e) => copyText(codeEl.textContent, e.currentTarget));

    // Result area.
    const result = $('.api-result', card);
    const statusEl = $('.api-status', card);
    const resultBody = $('.api-result-body code', card);

    const showResult = (statusText, statusOk, text) => {
      result.hidden = false;
      statusEl.textContent = statusText;
      statusEl.className = 'api-status ' + (statusOk ? 'ok' : 'err');
      resultBody.textContent = text;
    };

    // Run.
    const runBtn = $('.api-run', card);
    if (ep.runnable === false) {
      runBtn.remove();
    } else {
      runBtn.addEventListener('click', async () => {
        // Validate POST body JSON before sending.
        let opts = { method: ep.method };
        if (ep.method === 'POST') {
          let parsed;
          try { parsed = JSON.parse(bodyArea.value); }
          catch (_) {
            showResult('400', false, t('api.invalid_json'));
            return;
          }
          opts.body = JSON.stringify(parsed);
          opts.headers = { 'Content-Type': 'application/json' };
        }

        const orig = runBtn.textContent;
        runBtn.disabled = true;
        runBtn.textContent = t('api.running');
        try {
          const r = await apiRaw(buildPathWithQuery(ep), opts);
          const statusText = String(r.status);
          if (r.binary) {
            showResult(statusText, r.ok, '[binary response: ' + (r.ctype || 'unknown content-type') + ']');
          } else if (r.data != null) {
            showResult(statusText, r.ok, prettyJSON(r.data));
          } else {
            showResult(statusText, r.ok, r.raw || '(empty response)');
          }
        } catch (err) {
          showResult('—', false, 'Request failed: ' + (err && err.message ? err.message : String(err)));
        } finally {
          runBtn.disabled = false;
          runBtn.textContent = orig;
        }
      });
    }

    return card;
  }

  function renderSections() {
    const host = $('#api-sections');
    const tpl = $('#api-card-tpl');
    if (!host || !tpl) return;
    host.innerHTML = '';

    SECTIONS.forEach((sec) => {
      const wrap = document.createElement('section');
      wrap.className = 'api-section';
      const h = document.createElement('h2');
      h.className = 'api-section-title';
      h.textContent = sec.title;
      wrap.appendChild(h);

      const grid = document.createElement('div');
      grid.className = 'api-cards';
      sec.endpoints.forEach((ep) => grid.appendChild(renderCard(ep, tpl)));
      wrap.appendChild(grid);
      host.appendChild(wrap);
    });

    // Translate the freshly-rendered card labels.
    applyTranslations(host);
  }

  // ============================================================== boot
  async function boot() {
    // Base URL = the page origin (the same-origin proxy prefix).
    const baseEl = $('#api-baseurl');
    if (baseEl) baseEl.textContent = ORIGIN;
    const baseCopy = $('#api-baseurl-copy');
    if (baseCopy) baseCopy.addEventListener('click', (e) => copyText(ORIGIN, e.currentTarget));

    await setLanguage(pickInitialLang(), false);

    const langSel = $('#lang-select');
    if (langSel) langSel.addEventListener('change', (e) => setLanguage(e.target.value));

    renderSections();

    // version in the footer (best-effort)
    apiRaw('health').then((r) => {
      if (r.ok && r.data && r.data.version) {
        const v = $('#foot-version');
        if (v) v.textContent = 'v' + r.data.version;
      }
    }).catch(() => { /* ignore */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
