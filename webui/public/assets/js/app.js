/* DedrisGenAI — front-end controller
 * Vanilla JS, no framework. Talks only to same-origin /api/* (the PHP proxy).
 *
 * API endpoints used (mirror DEDRIS_SPEC.md §5):
 *   GET  /api/health                      -> { status, version, device }   // device: cuda|mps|cpu|...
 *   GET  /api/options                     -> { presets, performances, aspect_ratios,
 *                                              samplers, schedulers, output_formats,
 *                                              styles:[{name,preview}], models:{checkpoints,loras,vaes} }
 *   GET  /api/preset?name=Standard        -> preset defaults (see normalizePreset())
 *   POST /api/generate  (JSON body)       -> { task_id }
 *   GET  /api/progress?task_id=ID         -> { state, progress, preview, message, images }
 *   POST /api/stop      { task_id }       -> { ok }
 *   GET  /api/lang?code=it                -> { "<key>": "<translation>", ..., _lang }
 *   GET  /outputs/<path>                  -> image bytes (served via proxy)
 *
 * Two UI concerns layered on top of the original controller:
 *   1. i18n (it/en/de/fr/es)   — applies data-i18n* attributes from a dictionary.
 *   2. Rich progress UX        — elapsed timer, indeterminate bar, stage hints,
 *                                first-run note, localized state messages.
 *
 * The interface is always Advanced (the old Simple/Advanced toggle was removed):
 * html.mode-advanced is set by the PHP head-script and never changes.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
    return n;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Human-friendly byte size using GB/MB (e.g. 8589934592 -> "8 GB",
  // 209715200 -> "200 MB"). Falls back to KB/bytes for very small values.
  function formatBytes(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b < 0) return '';
    const GB = 1024 * 1024 * 1024;
    const MB = 1024 * 1024;
    const KB = 1024;
    if (b >= GB) { const v = b / GB; return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + ' GB'; }
    if (b >= MB) { return Math.round(b / MB) + ' MB'; }
    if (b >= KB) { return Math.round(b / KB) + ' KB'; }
    return b + ' B';
  }

  async function api(path, opts = {}) {
    const res = await fetch('api/' + path.replace(/^\/?api\//, '').replace(/^\//, ''), {
      headers: { 'Accept': 'application/json' },
      ...opts,
    });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { _raw: text }; }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }
  const apiGet  = (path) => api(path);
  const apiPost = (path, body) =>
    api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body || {}) });

  // outputs are served same-origin through the proxy; pass-through any absolute/relative form.
  function outputUrl(p) {
    if (!p) return '';
    if (/^(https?:|data:)/.test(p)) return p;
    return p.replace(/^\/+/, ''); // "/outputs/x.png" -> "outputs/x.png" (router serves it)
  }

  // ============================================================== i18n
  const LANGS = ['en', 'it', 'de', 'fr', 'es'];
  const DEFAULT_LANG = (document.documentElement.dataset.defaultLang) || 'en';
  const LS_LANG = 'dedris.lang';
  const LS_TASK = 'dedris.task';   // in-flight task id, so a page refresh can reconnect
  const LS_RESULTS = 'dedris.results'; // accumulated result entries, survive a refresh
  const LS_PERF = 'dedris.perf_open'; // Performance collapsible open/closed state
  const LS_MODELS_OPEN = 'dedris.models_open'; // Models accordion open/closed state
  const LS_PENDING_STYLE = 'dedris.pendingStyle'; // style chosen on the demo page to preselect
  const RESULTS_CAP = 200;         // cap the persisted/in-memory feed length

  const i18n = {
    lang: DEFAULT_LANG,
    dict: {},            // current dictionary
    cache: {},           // lang -> dictionary
  };

  /** Resolve a key, with {placeholder} interpolation. Falls back to the key. */
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
      dict = await apiGet('lang?code=' + encodeURIComponent(lang));
    } catch (e) {
      // Fallback: try the static i18n file path directly.
      try {
        const res = await fetch('../i18n/' + lang + '.json', { headers: { Accept: 'application/json' } });
        dict = res.ok ? await res.json() : null;
      } catch (_) { dict = null; }
    }
    if (!dict || typeof dict !== 'object') dict = i18n.cache[DEFAULT_LANG] || {};
    i18n.cache[lang] = dict;
    return dict;
  }

  /** Apply the current dictionary to every data-i18n* node in the document. */
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
    refreshDynamicI18n();
  }

  /** Re-render / re-label things that aren't plain data-i18n nodes. */
  function refreshDynamicI18n() {
    // preset chips carry localized display names (values stay Standard/Anime/Realistic)
    relabelPresetChips();
    // styles grid (placeholders carry translated alt/title)
    renderStyles($('#style-search') ? $('#style-search').value : '');
    // results feed (image alt text is localized)
    if (typeof renderFeed === 'function') renderFeed();
    // generate button label reflects current generating state
    setGenLabel();
    // engine pill + selected-state messages, if idle
    if (!state.generating) refreshEnginePill();
    // if a banner is showing one of our keyed messages, re-render it
    if (state.bannerKey) showBanner(state.bannerKind, t(state.bannerKey, state.bannerVars), state.bannerSpin);
    // progress message if idle/holding a keyed message
    if (state.progressKey) {
      $('#progress-msg').textContent = t(state.progressKey, state.progressVars);
    }
    // model-download bar text (if showing a keyed message)
    if (state.modelBusy && state.modelBarKey) {
      const el2 = document.getElementById('model-bar-text');
      if (el2) el2.textContent = t(state.modelBarKey);
      // re-render the localized download-size / file detail line too
      if (state.modelLastData) renderModelProgress(state.modelLastData);
    }
    // re-localize the inpaint editor's dynamic bits
    if (typeof refreshInpaintI18n === 'function') refreshInpaintI18n();
    // re-fetch + re-render the time estimate so its localized phrase updates
    if (typeof refreshEstimate === 'function') refreshEstimate();
  }

  // ============================================================== interface mode
  // The Simple/Advanced toggle was removed: the UI is ALWAYS Advanced. The PHP
  // head-script sets html.mode-advanced before app.js runs; we just make sure it
  // is present and seed state.mode so any remaining reads stay consistent.
  function initMode() {
    const root = document.documentElement;
    root.classList.remove('mode-simple');
    root.classList.add('mode-advanced');
    state.mode = 'advanced';
  }

  // ============================================================== Performance control
  // Performance used to be a collapsible (#performance-section) in the left column.
  // It now lives as a plain labeled control inside the Settings modal, so there is
  // no collapsible open/closed state to manage. The function is kept as a guarded
  // no-op so the boot sequence stays stable even if the element is absent.
  function initPerformanceSection() {
    const sec = $('#performance-section');
    if (!sec) return; // Performance is no longer collapsible (moved to Settings modal).
    let open = false;
    try { open = localStorage.getItem(LS_PERF) === '1'; } catch (_) {}
    sec.open = open;
    sec.addEventListener('toggle', () => {
      try { localStorage.setItem(LS_PERF, sec.open ? '1' : '0'); } catch (_) {}
    });
  }

  // ============================================================== Models accordion
  // The Models panel (base model / refiner / refiner switch / 5 LoRAs) is a
  // collapsible <details>. It defaults to collapsed; the open/closed state is
  // persisted in localStorage so it survives a refresh.
  function initModelsAccordion() {
    const sec = $('#models-accordion');
    if (!sec) return;
    let open = false;
    try { open = localStorage.getItem(LS_MODELS_OPEN) === '1'; } catch (_) {}
    sec.open = open;   // default collapsed unless the user opened it before
    sec.addEventListener('toggle', () => {
      try { localStorage.setItem(LS_MODELS_OPEN, sec.open ? '1' : '0'); } catch (_) {}
    });
  }

  // ---------------------------------------------------------------- fallbacks
  // Used only if /api/options is unreachable, so the UI is never empty.
  const FALLBACK = {
    presets: ['Standard', 'Anime', 'Realistic'],
    performances: ['Quality', 'Speed', 'Extreme Speed', 'Lightning', 'Hyper-SD'],
    aspect_ratios: [
      '704*1408', '768*1344', '832*1216', '896*1152', '1024*1024',
      '1152*896', '1216*832', '1344*768', '1408*704'
    ],
    samplers: ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde_gpu', 'dpmpp_sde_gpu', 'ddim', 'uni_pc'],
    schedulers: ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'turbo'],
    output_formats: ['png', 'jpeg', 'webp'],
    styles: [{ name: 'DedrisGenAI V2', preview: null }, { name: 'DedrisGenAI Enhance', preview: null }, { name: 'DedrisGenAI Sharp', preview: null }],
    models: { checkpoints: [], loras: ['None'], vaes: ['Default (model)'] },
  };

  // ---------------------------------------------------------------- state
  const state = {
    options: null,
    styles: [],            // [{name, preview}]
    selectedStyles: new Set(),
    results: [],           // ordered list of result entries {url, prompt, negative_prompt} (newest first on render)
    resultsSet: new Set(), // dedupe guard for state.results (keyed by url)
    runPrompt: '',         // prompt used by the in-flight generation (attached to its results)
    runNegative: '',       // negative prompt used by the in-flight generation
    activePreset: 'Standard',
    activeTab: 'text',
    taskId: null,
    polling: false,
    pollTimer: null,
    generating: false,
    mode: 'advanced',
    // progress bookkeeping
    startTime: 0,
    elapsedTimer: null,
    hintTimer: null,
    hintIdx: 0,
    sawProgress: false,
    firstRunDone: false,   // becomes true after the first successful generation
    // i18n-aware message bookkeeping (so language switches re-render live text)
    bannerKey: null, bannerVars: null, bannerKind: 'info', bannerSpin: false,
    progressKey: null, progressVars: null,
    enginePillKey: null, enginePillVars: null,
    // model-download bookkeeping (Feature 1): true while a preset's model is
    // downloading, which keeps the Generate button disabled with a loading bar.
    modelBusy: false,
    modelPreset: null,
    modelPollTimer: null,
    modelStartTime: 0,
    modelElapsedTimer: null,
    modelBarKey: null,
    modelLastData: null,
    // lightbox: prompt + negative of the currently-open image (for Copy buttons)
    lbPrompt: '', lbNegative: '',
  };
  const LORA_COUNT = 5;

  // rotating stage hints shown while progress is indeterminate
  const HINT_KEYS = ['progress.preparing', 'progress.loading_model', 'progress.generating'];

  // ---------------------------------------------------------------- engine status / banner
  const elStatus = $('#engine-status');
  const elBanner = $('#banner');
  const elBannerText = $('#banner-text');
  const elBannerSpin = $('#banner-spinner');

  // Set the engine status pill. `key` is an i18n key; `vars` are optional
  // interpolation vars (used by the device-aware ready messages, which carry a
  // {ready} placeholder). The pill re-renders its text on a language change via
  // refreshEnginePill().
  function setEngine(status, key, vars) {
    state.enginePillKey = key;
    state.enginePillVars = vars || null;
    elStatus.className = 'engine-pill ' + status;
    $('.txt', elStatus).textContent = t(key, vars);
  }
  function refreshEnginePill() {
    if (!state.enginePillKey) return;
    let vars = state.enginePillVars;
    // The device-aware ready messages embed t('engine.ready'); recompute it so a
    // language change re-localizes the nested word, not just the outer template.
    if (vars && Object.prototype.hasOwnProperty.call(vars, 'ready')) {
      vars = { ...vars, ready: t('engine.ready') };
    }
    $('.txt', elStatus).textContent = t(state.enginePillKey, vars);
  }
  // Map a health `device` string to the right device-aware ready i18n key.
  // cuda -> NVIDIA CUDA, mps -> Apple Metal, cpu -> CPU; anything else -> generic.
  function engineReadyKey(device) {
    const d = String(device || '').toLowerCase();
    if (d.indexOf('cuda') === 0 || d.indexOf('nvidia') === 0) return 'engine.ready.cuda';
    if (d.indexOf('mps') === 0 || d.indexOf('metal') === 0)   return 'engine.ready.mps';
    if (d.indexOf('cpu') === 0)                                return 'engine.ready.cpu';
    return null;   // unknown device -> fall back to the plain ready message
  }
  /** Show a banner from an i18n key (re-rendered on language change). */
  function showBannerKey(kind, key, vars, spinning) {
    state.bannerKey = key; state.bannerVars = vars || null; state.bannerKind = kind; state.bannerSpin = !!spinning;
    showBanner(kind, t(key, vars), spinning);
  }
  function showBanner(kind, text, spinning) {
    elBanner.className = 'banner show ' + kind;
    elBannerText.textContent = text;
    elBannerSpin.style.display = spinning ? '' : 'none';
  }
  function hideBanner() { elBanner.className = 'banner'; state.bannerKey = null; }

  // ---------------------------------------------------------------- model download (Feature 1)
  // On preset selection we ask the engine to ensure that preset's model is
  // present (POST /api/ensure_model), then poll GET /api/model_status while it
  // is "downloading", showing a friendly loading bar and disabling Generate.
  // We never surface an error for an in-progress download — only on real errors.
  const elModelBar = $('#model-bar');
  const elModelBarText = $('#model-bar-text');
  const elModelBarElapsed = $('#model-bar-elapsed');
  const elModelBarFill = $('#model-bar-fill');
  const elModelBarTrack = $('#model-bar-track');
  const elModelBarSize = $('#model-bar-size');
  const elModelBarFile = $('#model-bar-file');

  function fmtElapsedMs(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return mm + ':' + ss;
  }

  function showModelBar() {
    if (!elModelBar) return;
    elModelBar.classList.remove('hidden');
    state.modelBusy = true;
    updateGenerateEnabled();
    state.modelStartTime = state.modelStartTime || Date.now();
    if (elModelBarElapsed) elModelBarElapsed.textContent = fmtElapsedMs(Date.now() - state.modelStartTime);
    if (!state.modelElapsedTimer) {
      state.modelElapsedTimer = setInterval(() => {
        if (elModelBarElapsed) elModelBarElapsed.textContent = fmtElapsedMs(Date.now() - state.modelStartTime);
      }, 1000);
    }
  }

  function hideModelBar() {
    if (elModelBar) elModelBar.classList.add('hidden');
    state.modelBusy = false;
    state.modelStartTime = 0;
    if (state.modelElapsedTimer) { clearInterval(state.modelElapsedTimer); state.modelElapsedTimer = null; }
    // reset the download-size / file detail + determinate fill for next time
    if (elModelBarSize) { elModelBarSize.textContent = ''; elModelBarSize.classList.add('hidden'); }
    if (elModelBarFile) { elModelBarFile.textContent = ''; elModelBarFile.classList.add('hidden'); }
    if (elModelBarFill && elModelBarTrack) {
      elModelBarTrack.classList.remove('determinate');
      elModelBarFill.classList.remove('determinate');
      elModelBarFill.style.width = '';
    }
    updateGenerateEnabled();
  }

  function stopModelPolling() {
    if (state.modelPollTimer) { clearTimeout(state.modelPollTimer); state.modelPollTimer = null; }
  }

  // Kick off (or re-check) the model download for a preset. Safe to call on every
  // preset change and on initial load; a model that's already present resolves
  // to "ready" immediately and shows nothing.
  async function ensureModel(preset) {
    if (!preset) return;
    const switching = state.modelPreset !== preset;
    state.modelPreset = preset;
    stopModelPolling();
    if (switching) {
      // restart the elapsed clock for the newly selected preset
      state.modelStartTime = 0;
    }
    let data;
    try {
      data = await apiPost('ensure_model', { preset });
    } catch (e) {
      // Engine may still be starting; don't nag with a model error for that.
      // If a download was already shown, leave it; otherwise stay silent.
      return;
    }
    handleModelStatus(preset, data);
  }

  function handleModelStatus(preset, data) {
    // Ignore stale responses for a preset the user has since switched away from.
    if (state.modelPreset !== preset) return;
    const st = data && (data.state || data.status);

    if (st === 'downloading') {
      showModelBar();
      // localized base message; if the engine sent a human message, append it.
      state.modelBarKey = 'model.downloading';
      if (elModelBarText) {
        const base = t('model.downloading');
        const msg = (data && typeof data.message === 'string' && data.message.trim()) ? data.message.trim() : '';
        elModelBarText.textContent = msg && msg !== base ? msg : base;
      }
      // Download-size + current-file detail and a determinate fill (Feature 4).
      renderModelProgress(data);
      scheduleModelPoll(preset);
    } else if (st === 'error') {
      stopModelPolling();
      hideModelBar();
      const detail = (data && typeof data.message === 'string' && data.message.trim()) ? data.message.trim() : t('progress.error.unknown');
      showBannerKey('error', 'model.failed', { msg: detail }, false);
    } else {
      // ready | idle | anything else -> nothing to download, clear the bar.
      stopModelPolling();
      hideModelBar();
    }
  }

  // Render the download-size detail + determinate fill from a /api/model_status
  // payload. The engine may include: file, file_index, file_count,
  // downloaded_bytes, total_bytes. When total_bytes > 0 we show a determinate
  // fill (downloaded/total) and the "<downloaded> / <total>" size; otherwise we
  // fall back to the indeterminate animation and hide the size line.
  function renderModelProgress(data) {
    const d = data || {};
    state.modelLastData = d;   // kept so a language switch can re-render the size/file line
    const downloaded = Number(d.downloaded_bytes);
    const total = Number(d.total_bytes);
    const hasTotal = Number.isFinite(total) && total > 0;
    const hasDownloaded = Number.isFinite(downloaded) && downloaded >= 0;

    // size: "<downloaded> / <total>" (e.g. "200 MB / 8 GB")
    if (elModelBarSize) {
      if (hasTotal && hasDownloaded) {
        elModelBarSize.textContent = t('model.size', { downloaded: formatBytes(downloaded), total: formatBytes(total) });
        elModelBarSize.classList.remove('hidden');
      } else {
        elModelBarSize.textContent = '';
        elModelBarSize.classList.add('hidden');
      }
    }

    // current file line: name + "File <i> of <n>" if provided
    if (elModelBarFile) {
      const fileName = (typeof d.file === 'string' && d.file.trim()) ? d.file.trim() : '';
      const idx = Number(d.file_index);
      const count = Number(d.file_count);
      let line = fileName;
      if (Number.isFinite(idx) && Number.isFinite(count) && count > 0) {
        const counter = t('model.file', { index: idx, count });
        line = line ? (line + ' · ' + counter) : counter;
      }
      elModelBarFile.textContent = line;
      elModelBarFile.classList.toggle('hidden', !line);
    }

    // determinate vs indeterminate fill
    if (elModelBarFill && elModelBarTrack) {
      if (hasTotal && hasDownloaded) {
        const pct = Math.max(0, Math.min(100, (downloaded / total) * 100));
        elModelBarTrack.classList.add('determinate');
        elModelBarFill.classList.add('determinate');
        elModelBarFill.style.width = pct + '%';
      } else {
        elModelBarTrack.classList.remove('determinate');
        elModelBarFill.classList.remove('determinate');
        elModelBarFill.style.width = '';   // back to the CSS-driven indeterminate animation
      }
    }
  }

  function scheduleModelPoll(preset) {
    stopModelPolling();
    state.modelPollTimer = setTimeout(async () => {
      let data;
      try {
        data = await apiGet('model_status?preset=' + encodeURIComponent(preset));
      } catch (e) {
        // Transient: keep the bar, retry on the next tick.
        scheduleModelPoll(preset);
        return;
      }
      handleModelStatus(preset, data);
    }, 1500);
  }

  // ---------------------------------------------------------------- populate selectors
  function fillSelect(sel, items, { valueKey, labelKey } = {}) {
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';
    (items || []).forEach((it) => {
      const value = valueKey ? it[valueKey] : it;
      const label = labelKey ? it[labelKey] : it;
      sel.append(el('option', { value }, String(label)));
    });
    if (cur && items && items.some((it) => (valueKey ? it[valueKey] : it) === cur)) sel.value = cur;
  }

  // Fill a segmented (radio) control. The radio VALUE is always the raw item
  // (the engine API needs the original string); an optional labelFor(value)
  // maps it to a localized DISPLAY string shown to the user. The span carries a
  // data-seg-value so labels can be re-localized in place on a language change.
  function fillSegmented(container, items, name, checkedValue, labelFor) {
    container.innerHTML = '';
    (items || []).forEach((it) => {
      const id = name + '-' + String(it).replace(/[^a-z0-9]+/gi, '_');
      const label = labelFor ? labelFor(it) : String(it);
      const lab = el('label', { for: id },
        el('input', { type: 'radio', name, id, value: it }),
        el('span', { 'data-seg-value': String(it) }, label));
      if (it === checkedValue) $('input', lab).checked = true;
      container.append(lab);
    });
  }

  // Localized display name for a preset value (Standard/Anime/Realistic). The
  // value is kept as-is; only the visible text changes per language.
  function presetLabel(value) {
    return t('preset.opt.' + String(value).toLowerCase());
  }

  // Re-label the preset segmented chips in place (value attributes untouched) so
  // a language switch updates the visible names without rebuilding the control.
  function relabelPresetChips() {
    $$('#preset span[data-seg-value]').forEach((sp) => {
      sp.textContent = presetLabel(sp.getAttribute('data-seg-value'));
    });
  }
  const segValue = (name) => { const c = $(`input[name="${name}"]:checked`); return c ? c.value : null; };
  const setSeg   = (name, value) => { const r = $(`input[name="${name}"][value="${cssEsc(value)}"]`); if (r) r.checked = true; };
  const cssEsc   = (s) => String(s).replace(/"/g, '\\"');

  // ---------------------------------------------------------------- styles multi-select (with previews)
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

  function renderStyles(filter = '') {
    const list = $('#styles-list');
    const tpl = $('#style-chip-tpl');
    list.innerHTML = '';
    const f = filter.trim().toLowerCase();
    const matches = state.styles.filter((s) => !f || s.name.toLowerCase().includes(f));

    if (!matches.length) {
      list.append(el('div', { class: 'styles-empty' }, t('styles.empty')));
    } else {
      matches.forEach((s) => {
        const card = tpl.content.firstElementChild.cloneNode(true);
        card.classList.toggle('active', state.selectedStyles.has(s.name));
        card.setAttribute('title', s.name);
        card.setAttribute('aria-pressed', state.selectedStyles.has(s.name) ? 'true' : 'false');
        const thumb = $('.style-thumb', card);
        if (s.preview) {
          thumb.style.backgroundImage = 'url("' + outputUrl(s.preview) + '")';
          thumb.setAttribute('role', 'img');
          thumb.setAttribute('aria-label', t('styles.preview.alt', { name: s.name }));
        } else {
          // tasteful placeholder: initials on a per-style gradient
          const g = gradFor(s.name);
          thumb.classList.add('placeholder');
          thumb.style.background = 'linear-gradient(135deg,' + g[0] + ',' + g[1] + ')';
          thumb.textContent = styleInitials(s.name);
        }
        $('.style-name', card).textContent = s.name;
        card.addEventListener('click', () => toggleStyle(s.name));
        list.append(card);
      });
    }
    $('#styles-count').textContent = String(state.selectedStyles.size);
  }
  function toggleStyle(name) {
    if (state.selectedStyles.has(name)) state.selectedStyles.delete(name);
    else state.selectedStyles.add(name);
    renderStyles($('#style-search').value);
  }
  function setStyles(names) {
    state.selectedStyles = new Set(names || []);
    renderStyles($('#style-search').value);
  }

  // Demo page hand-off: the Examples gallery saves a chosen style name to
  // localStorage (dedris.pendingStyle), then navigates here. On boot we read it,
  // switch to a Text-to-Image view (where Styles live), preselect that style, and
  // clear the key so it only applies once. ?style= is also honoured as a fallback.
  function applyPendingStyle() {
    let name = null;
    try {
      const qs = new URLSearchParams(window.location.search);
      name = qs.get('style');
    } catch (_) { /* ignore */ }
    if (!name) {
      try { name = localStorage.getItem(LS_PENDING_STYLE); } catch (_) {}
    }
    try { localStorage.removeItem(LS_PENDING_STYLE); } catch (_) {}
    if (!name) return;
    // Only preselect a style the engine actually knows about (avoids dead chips).
    const known = state.styles.some((s) => s.name === name);
    if (!known) return;
    // Styles live in Text-to-Image, so make sure the Text tab is active.
    selectTab('text');
    state.selectedStyles.add(name);
    renderStyles($('#style-search') ? $('#style-search').value : '');
    updateStylesVisibility();
  }

  // The Styles picker belongs to Text-to-Image only. It is visible when the
  // active input tab is Text-to-Image and hidden for Edit Image (inpaint) and
  // Create variants (uov). Re-evaluated on every tab change.
  function updateStylesVisibility() {
    const card = $('#styles-card');
    if (!card) return;
    const showStyles = (state.activeTab !== 'inpaint' && state.activeTab !== 'uov');
    card.classList.toggle('hidden', !showStyles);
  }

  // ---------------------------------------------------------------- single prompt that follows the tab
  // There is exactly ONE prompt group in the page (#prompt-host, containing the
  // single #prompt + #negative_prompt). We MOVE that same DOM node into the mount
  // point that matches the active tab. Because it is the very same element being
  // re-parented (appendChild, not cloned), the typed value — and an active text
  // caret/focus — are preserved across tab switches.
  function placePrompt() {
    const host = $('#prompt-host');
    if (!host) return;
    let mount;
    if (state.activeTab === 'inpaint') {
      // Inpaint: inside the inpaint panel, above the mask editor.
      mount = $('#prompt-mount-inpaint');
    } else if (state.activeTab === 'uov') {
      // Create variants: inside the uov panel.
      mount = $('#prompt-mount-uov');
    } else {
      // Text to Image: inside the text-to-image panel.
      mount = $('#prompt-mount-text');
    }
    if (!mount) return;                       // guard for missing mount points
    if (host.parentNode === mount) return;    // already in the right place
    // Preserve focus across the move (re-parenting can drop the caret).
    const active = document.activeElement;
    const refocus = (active === $('#prompt') || active === $('#negative_prompt')) ? active : null;
    mount.appendChild(host);                  // same element -> value is preserved
    if (refocus && typeof refocus.focus === 'function') {
      try { refocus.focus({ preventScroll: true }); } catch (_) { refocus.focus(); }
    }
  }

  // ---------------------------------------------------------------- LoRA rows
  function buildLoraRows() {
    const wrap = $('#lora-rows');
    const tpl = $('#lora-row-tpl');
    wrap.innerHTML = '';
    for (let i = 0; i < LORA_COUNT; i++) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const range = $('.lora-weight', node);
      const out = $('.lora-weight-out', node);
      range.addEventListener('input', () => { out.textContent = Number(range.value).toFixed(2); });
      wrap.append(node);
    }
  }
  function fillLoraSelects(loras) {
    $$('.lora-name').forEach((sel) => fillSelect(sel, loras && loras.length ? loras : ['None']));
  }
  function getLoras() {
    return $$('#lora-rows .lora-row').map((row) => [
      $('.lora-enabled', row).checked,
      $('.lora-name', row).value || 'None',
      Number($('.lora-weight', row).value),
    ]);
  }
  function setLoras(loras) {
    const rows = $$('#lora-rows .lora-row');
    (loras || []).forEach((l, i) => {
      if (i >= rows.length) return;
      const row = rows[i];
      let enabled, name, weight;
      if (Array.isArray(l)) { [enabled, name, weight] = l; }
      else { enabled = l.enabled; name = l.name; weight = l.weight; }
      $('.lora-enabled', row).checked = enabled !== false;
      const sel = $('.lora-name', row);
      if (name && !Array.from(sel.options).some((o) => o.value === name)) sel.append(el('option', { value: name }, name));
      sel.value = name || 'None';
      const range = $('.lora-weight', row);
      range.value = (weight == null ? 1 : weight);
      $('.lora-weight-out', row).textContent = Number(range.value).toFixed(2);
    });
  }

  // Repopulate every LoRA-name <select> with a fresh `loras` list, PRESERVING each
  // row's current selection. Used after a new LoRA finishes downloading so it is
  // immediately selectable without rebuilding the rows (which would drop weights,
  // enabled flags and selections). If a row's current value is no longer in the
  // list (it shouldn't normally be) we keep it as an extra option so nothing is
  // silently lost.
  function setLoraSelectOptions(loras) {
    const list = (loras && loras.length) ? loras : ['None'];
    $$('.lora-name').forEach((sel) => {
      const cur = sel.value;
      sel.innerHTML = '';
      list.forEach((name) => sel.append(el('option', { value: name }, String(name))));
      if (cur && !list.some((n) => n === cur)) sel.append(el('option', { value: cur }, cur));
      if (cur) sel.value = cur;
    });
  }

  // Re-fetch /api/options and refresh the LoRA selectors in place, keeping every
  // row's current selection. Optionally auto-select `selectName` in the first row
  // that is currently empty/None, for convenience after adding a LoRA. Returns the
  // refreshed loras list (or null if options could not be loaded).
  async function refreshLoraOptions(selectName) {
    let opts;
    try {
      opts = await apiGet('options');
    } catch (e) {
      return null;
    }
    state.options = opts || state.options;
    const models = (opts && opts.models) || (state.options && state.options.models) || FALLBACK.models;
    const loras = (models.loras && models.loras.length) ? models.loras : ['None'];
    setLoraSelectOptions(loras);
    // Auto-select the freshly added LoRA in the first empty/None row.
    if (selectName && loras.some((n) => n === selectName)) {
      const rows = $$('#lora-rows .lora-row');
      const target = rows.find((row) => {
        const v = $('.lora-name', row).value;
        return !v || v === 'None';
      });
      if (target) {
        const sel = $('.lora-name', target);
        sel.value = selectName;
        const enabled = $('.lora-enabled', target);
        if (enabled) enabled.checked = true;
      }
    }
    return loras;
  }

  // ---------------------------------------------------------------- add LoRA from URL
  // Downloads a CivitAI/direct .safetensors URL into the engine's loras folder via
  // POST api/add_lora, then polls GET api/lora_status (~1.2s) showing a small
  // progress line. On "ready" it refreshes the LoRA selectors so the new LoRA is
  // usable immediately; on "error" it shows the engine's message and re-enables
  // the button. The same payload shape the engine returns is reused:
  //   { state, message, file, downloaded_bytes, total_bytes, lora_name }
  const loraAdd = {
    btn: null, url: null, token: null,
    progress: null, msg: null, track: null, fill: null,
    pollTimer: null, busy: false,
  };

  function loraAddSetBusy(on) {
    loraAdd.busy = on;
    if (loraAdd.btn) loraAdd.btn.disabled = on;
    if (loraAdd.url) loraAdd.url.disabled = on;
    if (loraAdd.token) loraAdd.token.disabled = on;
  }

  function loraAddShowProgress(show) {
    if (loraAdd.progress) loraAdd.progress.classList.toggle('hidden', !show);
  }

  function loraAddSetMsg(text, kind) {
    if (!loraAdd.msg) return;
    loraAdd.msg.textContent = text || '';
    loraAdd.msg.className = 'lora-add-msg' + (kind ? ' ' + kind : '');
  }

  // Update the small bar from a status payload: determinate when total_bytes>0,
  // otherwise indeterminate. Returns nothing.
  function loraAddRenderBar(data) {
    const d = data || {};
    const downloaded = Number(d.downloaded_bytes);
    const total = Number(d.total_bytes);
    const hasTotal = Number.isFinite(total) && total > 0;
    const hasDownloaded = Number.isFinite(downloaded) && downloaded >= 0;
    if (!loraAdd.track || !loraAdd.fill) return;
    if (hasTotal && hasDownloaded) {
      const pct = Math.max(0, Math.min(100, (downloaded / total) * 100));
      loraAdd.track.classList.add('determinate');
      loraAdd.fill.classList.add('determinate');
      loraAdd.fill.style.width = pct + '%';
    } else {
      loraAdd.track.classList.remove('determinate');
      loraAdd.fill.classList.remove('determinate');
      loraAdd.fill.style.width = '';
    }
  }

  function loraAddStopPolling() {
    if (loraAdd.pollTimer) { clearTimeout(loraAdd.pollTimer); loraAdd.pollTimer = null; }
  }

  // Render a downloading status line: file name + "<downloaded> / <total>".
  function loraAddDownloadingText(data) {
    const d = data || {};
    const file = (typeof d.file === 'string' && d.file.trim()) ? d.file.trim()
               : (typeof d.lora_name === 'string' && d.lora_name.trim()) ? d.lora_name.trim() : '';
    const downloaded = Number(d.downloaded_bytes);
    const total = Number(d.total_bytes);
    let size = '';
    if (Number.isFinite(total) && total > 0 && Number.isFinite(downloaded) && downloaded >= 0) {
      size = t('model.size', { downloaded: formatBytes(downloaded), total: formatBytes(total) });
    }
    let line = t('lora.add.downloading');
    if (file) line += ' · ' + file;
    if (size) line += ' · ' + size;
    return line;
  }

  function loraAddHandleStatus(data) {
    const st = data && (data.state || data.status);
    if (st === 'downloading') {
      loraAddSetMsg(loraAddDownloadingText(data));
      loraAddRenderBar(data);
      loraAddSchedulePoll();
    } else if (st === 'ready') {
      loraAddStopPolling();
      loraAddRenderBar({ downloaded_bytes: 1, total_bytes: 1 });   // full bar
      const name = (data && typeof data.lora_name === 'string' && data.lora_name.trim()) ? data.lora_name.trim() : '';
      loraAddSetMsg(t('lora.add.done', { name }), 'ok');
      // Refresh the LoRA selectors so the new LoRA is immediately usable.
      refreshLoraOptions(name);
      // Clear the inputs and re-enable for another add.
      if (loraAdd.url) loraAdd.url.value = '';
      loraAddSetBusy(false);
    } else if (st === 'error') {
      loraAddStopPolling();
      const detail = (data && typeof data.message === 'string' && data.message.trim()) ? data.message.trim() : t('progress.error.unknown');
      loraAddSetMsg(t('lora.add.error', { msg: detail }), 'err');
      loraAddRenderBar(null);
      loraAddSetBusy(false);
    } else {
      // idle / unknown: nothing in flight — stop quietly and re-enable.
      loraAddStopPolling();
      loraAddSetBusy(false);
    }
  }

  function loraAddSchedulePoll() {
    loraAddStopPolling();
    loraAdd.pollTimer = setTimeout(async () => {
      let data;
      try {
        data = await apiGet('lora_status');
      } catch (e) {
        // Transient (engine busy/unreachable): keep the bar, retry next tick.
        loraAddSchedulePoll();
        return;
      }
      loraAddHandleStatus(data);
    }, 1200);
  }

  async function onAddLora() {
    if (loraAdd.busy) return;
    const url = (loraAdd.url && loraAdd.url.value || '').trim();
    const token = (loraAdd.token && loraAdd.token.value || '').trim();
    if (!url) {
      loraAddShowProgress(true);
      loraAddRenderBar(null);
      loraAddSetMsg(t('lora.add.needurl'), 'err');
      if (loraAdd.url && typeof loraAdd.url.focus === 'function') { try { loraAdd.url.focus(); } catch (_) {} }
      return;
    }
    loraAddSetBusy(true);
    loraAddShowProgress(true);
    loraAddRenderBar(null);
    loraAddSetMsg(t('lora.add.downloading'));
    const body = { url };
    if (token) body.token = token;   // token omitted/empty allowed
    let data;
    try {
      data = await apiPost('add_lora', body);
    } catch (e) {
      const detail = (e && e.message) ? e.message : t('progress.error.unknown');
      loraAddSetMsg(t('lora.add.error', { msg: detail }), 'err');
      loraAddRenderBar(null);
      loraAddSetBusy(false);
      return;
    }
    loraAddHandleStatus(data);
  }

  function bindAddLora() {
    loraAdd.btn = $('#lora-add-btn');
    loraAdd.url = $('#lora-url');
    loraAdd.token = $('#lora-token');
    loraAdd.progress = $('#lora-add-progress');
    loraAdd.msg = $('#lora-add-msg');
    loraAdd.track = $('#lora-add-track');
    loraAdd.fill = $('#lora-add-fill');
    if (loraAdd.btn) loraAdd.btn.addEventListener('click', onAddLora);
    // Enter in the URL field triggers the add.
    if (loraAdd.url) loraAdd.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onAddLora(); } });
  }

  // ---------------------------------------------------------------- range output bindings
  function bindRange(id, fmt) {
    const r = document.getElementById(id);
    if (!r) return;
    const out = $(`[data-out="${id}"]`);
    const update = () => { if (out) out.textContent = fmt ? fmt(r.value) : r.value; };
    r.addEventListener('input', update);
    update();
  }

  // ---------------------------------------------------------------- options load
  function applyOptions(opts) {
    state.options = opts;
    const o = opts || {};

    fillSegmented($('#preset'), o.presets || FALLBACK.presets, 'preset', state.activePreset, presetLabel);
    $$('#preset input').forEach((r) => r.addEventListener('change', () => loadPreset(r.value)));

    fillSegmented($('#performance'), o.performances || FALLBACK.performances, 'performance', 'Speed');

    fillSelect($('#aspect_ratio'), o.aspect_ratios || FALLBACK.aspect_ratios);
    fillSelect($('#output_format'), o.output_formats || FALLBACK.output_formats);
    fillSelect($('#sampler'), o.samplers || FALLBACK.samplers);
    fillSelect($('#scheduler'), o.schedulers || FALLBACK.schedulers);

    const models = o.models || FALLBACK.models;
    fillSelect($('#base_model'), models.checkpoints && models.checkpoints.length ? models.checkpoints : [t('models.no_checkpoints')]);
    fillSelect($('#refiner_model'), ['None'].concat((models.checkpoints || []).filter((c) => c !== 'None')));
    fillSelect($('#vae'), models.vaes && models.vaes.length ? models.vaes : ['Default (model)']);
    fillLoraSelects(models.loras);

    // styles
    state.styles = (o.styles || FALLBACK.styles).map((s) => (typeof s === 'string' ? { name: s, preview: null } : s));
    renderStyles();
  }

  // ---------------------------------------------------------------- preset apply
  function normalizePreset(p) {
    if (!p) return {};
    const pick = (...keys) => { for (const k of keys) if (p[k] !== undefined) return p[k]; return undefined; };
    return {
      base_model:      pick('base_model', 'default_model'),
      refiner_model:   pick('refiner_model', 'default_refiner'),
      refiner_switch:  pick('refiner_switch', 'default_refiner_switch'),
      loras:           pick('loras', 'default_loras'),
      guidance_scale:  pick('guidance_scale', 'default_cfg_scale', 'cfg'),
      sharpness:       pick('sharpness', 'default_sample_sharpness'),
      sampler:         pick('sampler', 'default_sampler'),
      scheduler:       pick('scheduler', 'default_scheduler'),
      performance:     pick('performance', 'default_performance'),
      prompt:          pick('prompt', 'default_prompt'),
      negative_prompt: pick('negative_prompt', 'default_prompt_negative'),
      styles:          pick('style_selections', 'styles', 'default_styles'),
      aspect_ratio:    pick('aspect_ratio', 'default_aspect_ratio'),
      steps_override:  pick('steps_override', 'default_overwrite_step'),
      vae:             pick('vae', 'default_vae'),
      clip_skip:       pick('clip_skip', 'default_clip_skip'),
    };
  }

  function applyPreset(raw) {
    const p = normalizePreset(raw);
    const setVal = (id, v) => { const n = document.getElementById(id); if (n != null && v !== undefined && v !== null) n.value = v; };
    const setRange = (id, v) => { const n = document.getElementById(id); if (n && v !== undefined && v !== null) { n.value = v; n.dispatchEvent(new Event('input')); } };

    if (p.prompt !== undefined) setVal('prompt', p.prompt);
    if (p.negative_prompt !== undefined) setVal('negative_prompt', p.negative_prompt);
    if (p.performance) setSeg('performance', p.performance);
    if (p.aspect_ratio) setVal('aspect_ratio', p.aspect_ratio);
    if (p.base_model) {
      const sel = $('#base_model');
      if (!Array.from(sel.options).some((o) => o.value === p.base_model)) sel.append(el('option', { value: p.base_model }, p.base_model));
      sel.value = p.base_model;
    }
    if (p.refiner_model) setVal('refiner_model', p.refiner_model);
    setRange('refiner_switch', p.refiner_switch);
    setRange('guidance_scale', p.guidance_scale);
    setRange('sharpness', p.sharpness);
    if (p.sampler) setVal('sampler', p.sampler);
    if (p.scheduler) setVal('scheduler', p.scheduler);
    if (p.steps_override !== undefined) setVal('steps_override', p.steps_override);
    if (p.vae) setVal('vae', p.vae);
    setRange('clip_skip', p.clip_skip);
    if (p.loras) setLoras(p.loras);
    if (p.styles) setStyles(p.styles);
  }

  async function loadPreset(name) {
    state.activePreset = name;
    setSeg('preset', name);
    // Feature 1: make sure this preset's model is present; if it needs to be
    // downloaded (first use), this shows the loading bar and disables Generate.
    ensureModel(name);
    try {
      const p = await apiGet('preset?name=' + encodeURIComponent(name));
      applyPreset(p);
    } catch (e) {
      console.warn('preset load failed', e);
      showBannerKey('warn', 'banner.preset.failed', { name }, false);
      setTimeout(hideBanner, 4000);
    }
  }

  // ---------------------------------------------------------------- gather params
  function gatherParams() {
    const seedRandom = $('#seed_random').checked;
    return {
      preset: state.activePreset,
      prompt: $('#prompt').value,
      negative_prompt: $('#negative_prompt').value,
      style_selections: Array.from(state.selectedStyles),
      performance: segValue('performance') || 'Speed',
      aspect_ratio: $('#aspect_ratio').value,
      image_number: Number($('#image_number').value),
      output_format: $('#output_format').value,
      seed: seedRandom ? -1 : Number($('#seed').value),
      sharpness: Number($('#sharpness').value),
      guidance_scale: Number($('#guidance_scale').value),
      base_model: $('#base_model').value,
      refiner_model: $('#refiner_model').value,
      refiner_switch: Number($('#refiner_switch').value),
      loras: getLoras(),
      sampler: $('#sampler').value,
      scheduler: $('#scheduler').value,
      steps_override: Number($('#steps_override').value),
      vae: $('#vae').value,
      clip_skip: Number($('#clip_skip').value),
      input_mode: state.activeTab,            // text|uov|ip|inpaint|... (informational)
      uov_method: $('#uov_method') ? $('#uov_method').value : 'Disabled',
    };
  }

  // ---------------------------------------------------------------- live time estimate
  // Purely informational line shown under the Generate row. Reads the current
  // settings (performance / image number / aspect ratio / optional steps
  // override), asks the engine GET /api/estimate, and renders a localized phrase
  // from the returned numbers. It NEVER blocks generation and NEVER surfaces an
  // error: if the engine is unreachable the line is simply hidden.
  const elEstimate = $('#time-estimate');
  let estimateTimer = null;   // debounce handle
  let estimateSeq = 0;        // guards against out-of-order responses

  function hideEstimate() {
    if (elEstimate) { elEstimate.classList.add('hidden'); elEstimate.textContent = ''; }
  }

  // Render the estimate line from an /api/estimate payload using the localized
  // i18n template, so the phrase itself is translated.
  function renderEstimate(data) {
    if (!elEstimate || !data) { hideEstimate(); return; }
    const per = Math.round(Number(data.seconds_per_image));
    const total = Math.round(Number(data.total_seconds));
    const device = (data.device_name != null && String(data.device_name).trim()) ? String(data.device_name).trim() : '';
    const imageNumber = Number($('#image_number') ? $('#image_number').value : 1) || 1;
    if (!Number.isFinite(per) || per <= 0) { hideEstimate(); return; }

    const vars = { per, total: Number.isFinite(total) && total > 0 ? total : per, device };
    // For a single image, the "total" is redundant; use the shorter phrasing.
    const text = (imageNumber <= 1) ? t('estimate.line.one', vars) : t('estimate.line', vars);

    elEstimate.textContent = '';
    elEstimate.append(document.createTextNode(text));
    if (data.calibrated) {
      elEstimate.append(document.createTextNode(' '));
      elEstimate.append(el('span', { class: 'calibrated' }, t('estimate.calibrated')));
    }
    elEstimate.classList.remove('hidden');
  }

  // Fetch + render the current estimate (same-origin proxy). Debounced via
  // scheduleEstimate(); call this directly only for an immediate refresh.
  async function refreshEstimate() {
    if (!elEstimate) return;
    const seq = ++estimateSeq;
    const performance = segValue('performance') || 'Speed';
    const imageNumber = Number($('#image_number') ? $('#image_number').value : 1) || 1;
    const aspectRatio = $('#aspect_ratio') ? $('#aspect_ratio').value : '';
    const stepsEl = $('#steps_override');
    const stepsOverride = stepsEl ? Number(stepsEl.value) : -1;

    const qs = new URLSearchParams();
    qs.set('performance', performance);
    qs.set('image_number', String(imageNumber));
    if (aspectRatio) qs.set('aspect_ratio', aspectRatio);
    if (Number.isFinite(stepsOverride) && stepsOverride > 0) qs.set('steps_override', String(stepsOverride));

    let data;
    try {
      data = await apiGet('estimate?' + qs.toString());
    } catch (e) {
      // Engine unreachable / no estimate -> stay silent (never an error).
      if (seq === estimateSeq) hideEstimate();
      return;
    }
    if (seq !== estimateSeq) return;   // a newer request superseded this one
    renderEstimate(data);
  }

  // Debounced trigger used by the settings change/input listeners.
  function scheduleEstimate(delay = 250) {
    if (estimateTimer) clearTimeout(estimateTimer);
    estimateTimer = setTimeout(() => { estimateTimer = null; refreshEstimate(); }, delay);
  }

  // ---------------------------------------------------------------- generation flow
  const elGen = $('#btn-generate');
  const elStop = $('#btn-stop');
  const elSkip = $('#btn-skip');
  const elProgWrap = $('#progress-wrap');
  const elProgTrack = $('#progress-track');
  const elProgBar = $('#progress-bar');
  const elProgMsg = $('#progress-msg');
  const elProgPct = $('#progress-pct');
  const elProgElapsed = $('#progress-elapsed');
  const elFirstRun = $('#firstrun-note');
  const elPreviewImg = $('#preview-img');
  const elPreviewPh = $('#preview-placeholder');
  const elFeed = $('#results-feed');
  const elFeedHead = $('#results-feed-head');
  const elResultsCount = $('#results-count');

  function setGenLabel() {
    const txt = $('.txt', elGen);
    const ico = $('.ico', elGen);
    if (txt) txt.textContent = state.generating ? t('btn.generating') : t('btn.generate');
    if (ico) ico.textContent = state.generating ? '⏳' : '✨';
  }
  // Generate is disabled while generating OR while a preset's model downloads.
  function updateGenerateEnabled() {
    elGen.disabled = state.generating || state.modelBusy;
  }
  function setGenerating(on) {
    state.generating = on;
    updateGenerateEnabled();
    elStop.disabled = !on;
    elSkip.disabled = !on;
    setGenLabel();
    elProgWrap.classList.toggle('hidden', !on);
  }

  // -- elapsed timer ----------------------------------------------------------
  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return mm + ':' + ss;
  }
  function startTimers() {
    state.startTime = Date.now();
    state.sawProgress = false;
    state.hintIdx = 0;
    elProgElapsed.textContent = '00:00';
    stopTimers();
    state.elapsedTimer = setInterval(() => {
      elProgElapsed.textContent = fmtElapsed(Date.now() - state.startTime);
    }, 1000);
  }
  function stopTimers() {
    if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
    if (state.hintTimer) { clearInterval(state.hintTimer); state.hintTimer = null; }
  }

  // -- indeterminate vs determinate progress ----------------------------------
  function setIndeterminate(on, holdMsgKey) {
    elProgTrack.classList.toggle('indeterminate', on);
    if (on) {
      elProgPct.textContent = '';
      // rotate stage hints so it never looks frozen
      if (!state.hintTimer) {
        const rotate = () => {
          const key = HINT_KEYS[state.hintIdx % HINT_KEYS.length];
          state.progressKey = key; state.progressVars = null;
          elProgMsg.textContent = t(key);
          state.hintIdx++;
        };
        // show the first run note while indeterminate on the very first generation
        elFirstRun.classList.toggle('hidden', state.firstRunDone);
        if (holdMsgKey) { state.progressKey = holdMsgKey; state.progressVars = null; elProgMsg.textContent = t(holdMsgKey); }
        else rotate();
        state.hintTimer = setInterval(rotate, 3500);
      }
    } else {
      if (state.hintTimer) { clearInterval(state.hintTimer); state.hintTimer = null; }
      elFirstRun.classList.add('hidden');
    }
  }

  // map raw engine state -> our localized fallback key
  function stateKey(s) {
    return ({
      pending: 'progress.queued',
      queued: 'progress.queued',
      running: 'progress.rendering',
      loading: 'progress.loading_models',
      preparing: 'progress.preparing',
    })[s] || 'progress.working';
  }

  /**
   * Render a progress tick.
   *  - msg: the engine's own message string (carries the live stage text). When
   *    present we show it verbatim and prominently.
   *  - When progress is a real number > 0 we go determinate; otherwise we keep
   *    an animated indeterminate bar + rotating hints so it never looks stuck.
   */
  function renderProgress(data) {
    const st = data.state || data.status;
    const pct = Number(data.progress);
    const hasPct = Number.isFinite(pct) && pct > 0;
    const msg = (typeof data.message === 'string' && data.message.trim()) ? data.message.trim() : '';

    if (hasPct) {
      state.sawProgress = true;
      setIndeterminate(false);
      const p = Math.max(0, Math.min(100, Math.round(pct)));
      elProgBar.style.width = p + '%';
      elProgPct.textContent = p + '%';
      // engine message wins; otherwise localized state label
      state.progressKey = msg ? null : stateKey(st);
      state.progressVars = null;
      elProgMsg.textContent = msg || t(stateKey(st));
      // once we have real progress on the first run, the model is loaded
      elFirstRun.classList.add('hidden');
    } else {
      // unknown / zero progress while still running -> indeterminate
      const running = (st === 'running' || st === 'pending' || st === 'queued' || st === 'loading' || st === 'preparing' || st == null);
      if (running) {
        setIndeterminate(true);
        // if the engine gives us a live message, pin it (stop rotating hints)
        if (msg) {
          if (state.hintTimer) { clearInterval(state.hintTimer); state.hintTimer = null; }
          state.progressKey = null; state.progressVars = null;
          elProgMsg.textContent = msg;
        }
      } else {
        setIndeterminate(false);
        elProgBar.style.width = '0%';
        elProgPct.textContent = '0%';
        state.progressKey = msg ? null : stateKey(st);
        elProgMsg.textContent = msg || t(stateKey(st));
      }
    }
  }

  // simple determinate setter (used at submit/finish)
  function setProgress(pct, msgKeyOrText, isKey, vars) {
    setIndeterminate(false);
    const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    elProgBar.style.width = p + '%';
    elProgPct.textContent = p + '%';
    if (isKey) { state.progressKey = msgKeyOrText; state.progressVars = vars || null; elProgMsg.textContent = t(msgKeyOrText, vars); }
    else if (msgKeyOrText) { state.progressKey = null; elProgMsg.textContent = msgKeyOrText; }
  }

  function setPreview(dataUrl) {
    if (!dataUrl) return;
    elPreviewImg.src = dataUrl;
    elPreviewImg.classList.remove('hidden');
    elPreviewPh.classList.add('hidden');
  }
  // ---------------------------------------------------------------- accumulating results feed
  // Each feed entry is { url, prompt, negative_prompt }. Older persisted feeds
  // stored bare URL strings; loadResults() upgrades those to entries on read so
  // rendering never breaks on legacy data.
  function makeEntry(url, prompt, negative) {
    return { url, prompt: prompt || '', negative_prompt: negative || '' };
  }
  /** Persist the feed entries (capped) so a refresh keeps showing them. */
  function saveResults() {
    try { localStorage.setItem(LS_RESULTS, JSON.stringify(state.results.slice(0, RESULTS_CAP))); } catch (_) {}
  }
  /** Load any previously persisted feed entries into memory (string-tolerant). */
  function loadResults() {
    let saved = null;
    try { saved = localStorage.getItem(LS_RESULTS); } catch (_) {}
    if (!saved) return;
    let arr = [];
    try { arr = JSON.parse(saved); } catch (_) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    state.results = [];
    state.resultsSet = new Set();
    arr.forEach((item) => {
      // Backward compatibility: legacy entries were plain URL strings.
      const url = (typeof item === 'string') ? item : (item && item.url);
      if (!url || state.resultsSet.has(url)) return;
      const prompt = (item && typeof item === 'object') ? item.prompt : '';
      const negative = (item && typeof item === 'object') ? item.negative_prompt : '';
      state.resultsSet.add(url);
      state.results.push(makeEntry(url, prompt, negative));
    });
  }

  /**
   * Merge a batch of images into the persistent feed (dedupe by URL, keep
   * insertion order). Each new image is tagged with the prompt + negative prompt
   * that produced it (the in-flight run's, captured in onGenerate / recoverTask).
   * Returns true if anything new was added. The feed is the accumulating
   * history; it is never wiped when a new generation starts.
   */
  function addResults(images) {
    let added = false;
    const prompt = state.runPrompt || '';
    const negative = state.runNegative || '';
    (images || []).forEach((img) => {
      const url = outputUrl(img);
      if (!url || state.resultsSet.has(url)) return;
      state.resultsSet.add(url);
      state.results.push(makeEntry(url, prompt, negative));
      added = true;
    });
    if (added) {
      if (state.results.length > RESULTS_CAP) {
        const drop = state.results.splice(0, state.results.length - RESULTS_CAP);
        drop.forEach((e) => state.resultsSet.delete(e.url));
      }
      renderFeed();
      saveResults();
    }
    return added;
  }

  /** Render the whole feed, newest first. Each card keeps its click-to-lightbox
   *  behaviour and gains two action buttons (Edit Image / Create variants) that
   *  hand the image off to the matching input tab. The buttons stopPropagation so
   *  they never trigger the lightbox. */
  function renderFeed() {
    elFeed.innerHTML = '';
    // newest first
    for (let i = state.results.length - 1; i >= 0; i--) {
      const entry = state.results[i];
      const url = entry.url;
      const editBtn = el('button', {
        type: 'button', class: 'gallery-act gallery-act-edit',
        title: t('gallery.edit'), 'aria-label': t('gallery.edit'),
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); sendToInpaint(url); },
      }, el('span', { class: 'gallery-act-ico', 'aria-hidden': 'true' }, '🎨'),
         el('span', { class: 'gallery-act-txt' }, t('gallery.edit')));
      const varBtn = el('button', {
        type: 'button', class: 'gallery-act gallery-act-variants',
        title: t('gallery.variants'), 'aria-label': t('gallery.variants'),
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); sendToVariants(url); },
      }, el('span', { class: 'gallery-act-ico', 'aria-hidden': 'true' }, '🖼️'),
         el('span', { class: 'gallery-act-txt' }, t('gallery.variants')));
      const actions = el('div', { class: 'gallery-actions' }, editBtn, varBtn);
      // A small caption hint on the card shows the prompt is saved (and is the
      // image's tooltip); clicking the card opens the lightbox with full details.
      const imgAttrs = { src: url, alt: t('results.preview.alt'), loading: 'lazy' };
      if (entry.prompt) imgAttrs.title = entry.prompt;
      const a = el('a', { href: '#', class: 'gallery-item', onclick: (e) => { e.preventDefault(); openLightbox(entry); } },
        el('img', imgAttrs),
        actions);
      if (entry.prompt) a.append(el('span', { class: 'gallery-caption' }, entry.prompt));
      elFeed.append(a);
    }
    const n = state.results.length;
    if (elResultsCount) elResultsCount.textContent = String(n);
    if (elFeedHead) elFeedHead.hidden = (n === 0);
  }

  /** Empty the feed and its persisted copy. */
  function clearResults() {
    state.results = [];
    state.resultsSet = new Set();
    renderFeed();
    try { localStorage.removeItem(LS_RESULTS); } catch (_) {}
  }

  async function onGenerate() {
    if (state.generating) return;

    // Inpaint tab: if an image is loaded we send the mask payload. Block the run
    // with a localized hint if no region has been painted yet (no empty inpaint).
    let inpaintExtra = null;
    if (state.activeTab === 'inpaint' && inpaintHasImage()) {
      if (!inpaintReady()) {
        showBannerKey('warn', 'inpaint.paint_hint', null, false);
        setTimeout(hideBanner, 4000);
        return;
      }
      inpaintExtra = inpaintPayload();
    }

    // Create variants (uov) tab: an image is required. Block with a localized hint
    // if nothing was uploaded, otherwise send the source image + vary method.
    let uovExtra = null;
    if (state.activeTab === 'uov') {
      if (!uovHasImage()) {
        showBannerKey('warn', 'uov.need_image', null, false);
        setTimeout(hideBanner, 4000);
        return;
      }
      uovExtra = uovPayload();
    }

    setGenerating(true);
    startTimers();
    setIndeterminate(true);                 // start animated immediately
    setProgress(0, 'progress.submitting', true);
    setIndeterminate(true);
    // NOTE: do NOT clear the feed — results accumulate across generations.
    try {
      const params = gatherParams();
      if (inpaintExtra) Object.assign(params, inpaintExtra);
      if (uovExtra) Object.assign(params, uovExtra);
      // Remember the prompt + negative used, so each resulting image can carry
      // them in the feed (and the lightbox can show + copy them).
      state.runPrompt = params.prompt || '';
      state.runNegative = params.negative_prompt || '';
      const res = await apiPost('generate', params);
      state.taskId = res && (res.task_id || res.id);
      if (!state.taskId) throw new Error(t('progress.no_task'));
      // Persist the in-flight task so a page refresh can reconnect to it.
      try { localStorage.setItem(LS_TASK, JSON.stringify({ id: state.taskId, ts: state.startTime })); } catch (_) {}
      hideBanner();
      pollProgress();
    } catch (e) {
      console.error('generate failed', e);
      finishGenerating();
      if (e.status === 0 || e.message === 'Failed to fetch') {
        showBannerKey('error', 'banner.engine.notreachable.generate', null, false);
      } else {
        showBannerKey('error', 'progress.failed', { msg: e.message }, false);
      }
    }
  }

  async function pollProgress() {
    state.polling = true;
    while (state.polling && state.taskId) {
      let data;
      try {
        data = await apiGet('progress?task_id=' + encodeURIComponent(state.taskId));
      } catch (e) {
        setIndeterminate(true);
        state.progressKey = 'progress.lost'; elProgMsg.textContent = t('progress.lost');
        showBannerKey('warn', 'banner.contact.lost', null, true);
        await sleep(1200);
        continue;
      }
      hideBanner();
      const st = data.state || data.status;
      renderProgress(data);
      if (data.preview) setPreview(data.preview);

      // Progressive results: the engine reports images already saved during the
      // run. Merge them into the accumulating feed so they appear one by one.
      if (Array.isArray(data.images) && data.images.length) {
        addResults(data.images);
        setPreview(outputUrl(data.images[data.images.length - 1]));
      }

      if (st === 'done' || st === 'finished' || st === 'completed') {
        const imgs = data.images || [];
        addResults(imgs);
        if (imgs.length) setPreview(outputUrl(imgs[imgs.length - 1]));
        setProgress(100, 'results.done', true, { count: imgs.length });
        state.firstRunDone = true;
        finishGenerating();
        return;
      }
      if (st === 'error' || st === 'failed') {
        setIndeterminate(false);
        const detail = (data.message && data.message.trim()) ? data.message.trim() : t('progress.error.unknown');
        showBannerKey('error', 'progress.error', { msg: detail }, false);
        state.progressKey = 'progress.error'; state.progressVars = { msg: detail };
        elProgMsg.textContent = t('progress.error', { msg: detail });
        finishGenerating();
        return;
      }
      if (st === 'stopped' || st === 'cancelled' || st === 'canceled') {
        setProgress(Number(data.progress) || 0, 'progress.stopped', true);
        finishGenerating();
        return;
      }
      if (st === 'unknown') {
        // The engine no longer knows this task (e.g. it was restarted). Stop quietly.
        setIndeterminate(false);
        showBannerKey('warn', 'banner.task.lost', null, false);
        finishGenerating();
        return;
      }
      await sleep(700);
    }
  }

  // Reconnect to an in-flight task after a page refresh (point: refreshing must
  // not lose a running generation). Reads the persisted task id and resumes.
  async function recoverTask() {
    let saved = null;
    try { saved = localStorage.getItem(LS_TASK); } catch (_) {}
    if (!saved) return;
    let id = saved, ts = null;
    try { const o = JSON.parse(saved); if (o && o.id) { id = o.id; ts = o.ts || null; } } catch (_) {}

    let data;
    try {
      data = await apiGet('progress?task_id=' + encodeURIComponent(id));
    } catch (e) {
      // Engine unreachable/starting — keep the id and let a future load retry.
      return;
    }
    const st = data.state || data.status;

    if (st === 'running' || st === 'pending' || st === 'queued' || st === 'loading' || st === 'preparing') {
      // Resume the live task: restore UI + continue polling, keeping elapsed continuous.
      state.taskId = id;
      setGenerating(true);
      startTimers();
      if (ts) state.startTime = ts;          // continue the original elapsed clock
      hideBanner();
      renderProgress(data);
      if (data.preview) setPreview(data.preview);
      // Merge any results already produced before the refresh.
      if (Array.isArray(data.images) && data.images.length) {
        addResults(data.images);
        setPreview(outputUrl(data.images[data.images.length - 1]));
      }
      showBannerKey('info', 'banner.task.resumed', null, true);
      pollProgress();
    } else if (st === 'done' || st === 'finished' || st === 'completed') {
      // Finished while we were away — merge its results into the feed.
      const imgs = data.images || [];
      addResults(imgs);
      if (imgs.length) setPreview(outputUrl(imgs[imgs.length - 1]));
      setProgress(100, 'results.done', true, { count: imgs.length });
      try { localStorage.removeItem(LS_TASK); } catch (_) {}
    } else {
      // error / stopped / unknown — clear silently.
      try { localStorage.removeItem(LS_TASK); } catch (_) {}
    }
  }

  function finishGenerating() {
    state.polling = false;
    state.taskId = null;
    try { localStorage.removeItem(LS_TASK); } catch (_) {}
    stopTimers();
    setGenerating(false);
    // A run just completed: the engine may now have a calibrated (measured)
    // estimate, so refresh the informational line.
    refreshEstimate();
  }

  async function onStop() {
    if (!state.taskId) { finishGenerating(); return; }
    try { await apiPost('stop', { task_id: state.taskId }); } catch (e) { /* ignore */ }
    state.progressKey = 'progress.stopping';
    elProgMsg.textContent = t('progress.stopping');
  }
  async function onSkip() {
    if (!state.taskId) return;
    try { await apiPost('skip', { task_id: state.taskId }); } catch (e) { /* best-effort */ }
  }

  // ---------------------------------------------------------------- lightbox
  const lb = $('#lightbox');
  const lbImg = $('#lightbox-img');
  const lbCaption = $('#lightbox-caption');
  const lbPromptField = $('#lb-prompt-field');
  const lbPrompt = $('#lb-prompt');
  const lbNegativeField = $('#lb-negative-field');
  const lbNegative = $('#lb-negative');
  const lbCopyPrompt = $('#lb-copy-prompt');
  const lbCopyNegative = $('#lb-copy-negative');

  // Copy helper: clipboard API with a textarea fallback (file:// / http). Flashes
  // a localized "Copied" label on the button for quick feedback.
  function copyText(text, btn) {
    if (text == null) return;
    const flash = () => {
      if (!btn) return;
      const orig = btn.getAttribute('data-i18n');
      const prev = btn.textContent;
      btn.textContent = t('result.copied');
      setTimeout(() => { btn.textContent = orig ? t(orig) : prev; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, () => fallbackCopy(text, flash));
    } else {
      fallbackCopy(text, flash);
    }
  }
  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (done) done();
    } catch (_) { /* ignore */ }
  }

  // Accepts a feed entry {url, prompt, negative_prompt} or a bare URL string
  // (legacy callers). Shows the prompt + negative caption when present.
  function openLightbox(entryOrUrl) {
    const entry = (typeof entryOrUrl === 'string') ? { url: entryOrUrl, prompt: '', negative_prompt: '' } : (entryOrUrl || {});
    lbImg.src = entry.url || '';
    const prompt = entry.prompt || '';
    const negative = entry.negative_prompt || '';

    if (prompt) {
      lbPrompt.textContent = prompt;
      if (lbPromptField) lbPromptField.classList.remove('hidden');
    } else {
      lbPrompt.textContent = t('result.no_prompt');
      if (lbPromptField) lbPromptField.classList.remove('hidden');
    }
    if (lbCopyPrompt) lbCopyPrompt.classList.toggle('hidden', !prompt);

    if (negative) {
      lbNegative.textContent = negative;
      if (lbNegativeField) lbNegativeField.classList.remove('hidden');
    } else if (lbNegativeField) {
      lbNegativeField.classList.add('hidden');
    }
    if (lbCopyNegative) lbCopyNegative.classList.toggle('hidden', !negative);

    // Always show the caption block (it carries at least the prompt line).
    if (lbCaption) lbCaption.classList.remove('hidden');

    // wire copy buttons to this image's text
    state.lbPrompt = prompt;
    state.lbNegative = negative;
    lb.classList.add('show');
  }
  function closeLightbox() { lb.classList.remove('show'); }
  $('#lightbox-close').addEventListener('click', closeLightbox);
  if (lbCopyPrompt) lbCopyPrompt.addEventListener('click', (e) => { e.stopPropagation(); copyText(state.lbPrompt, lbCopyPrompt); });
  if (lbCopyNegative) lbCopyNegative.addEventListener('click', (e) => { e.stopPropagation(); copyText(state.lbNegative, lbCopyNegative); });
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

  // ---------------------------------------------------------------- settings modal
  // A general "Settings" dialog opened by the gear button next to the language
  // selector. It is a SEPARATE element + handlers from the image lightbox above.
  // Currently it hosts the Output format control (#output_format), which is still
  // populated from /api/options by applyOptions() exactly as before.
  const settingsModal = $('#settings-modal');
  function isSettingsOpen() { return !!settingsModal && settingsModal.classList.contains('show'); }
  function openSettings() {
    if (!settingsModal) return;
    settingsModal.classList.add('show');
    settingsModal.setAttribute('aria-hidden', 'false');
    const dialog = $('#settings-dialog');
    if (dialog && typeof dialog.focus === 'function') {
      try { dialog.focus({ preventScroll: true }); } catch (_) { dialog.focus(); }
    }
  }
  function closeSettings() {
    if (!settingsModal) return;
    settingsModal.classList.remove('show');
    settingsModal.setAttribute('aria-hidden', 'true');
    const gear = $('#btn-settings');
    if (gear && typeof gear.focus === 'function') { try { gear.focus(); } catch (_) {} }
  }
  if (settingsModal) {
    const gear = $('#btn-settings');
    if (gear) gear.addEventListener('click', openSettings);
    const closeBtn = $('#settings-close');
    if (closeBtn) closeBtn.addEventListener('click', closeSettings);
    // click on the backdrop (outside the dialog) closes it
    settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
    // Escape closes the settings modal (separate from the lightbox handler)
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isSettingsOpen()) closeSettings(); });
  }

  // ---------------------------------------------------------------- tabs
  // Three input modes are wired and rendered: Text to Image, Edit Image (inpaint)
  // and Create variants (uov).
  function selectTab(name) {
    const tab = $(`#input-tabs .tab[data-tab="${name}"]`);
    if (!tab) return;
    $$('#input-tabs .tab').forEach((t2) => t2.classList.remove('active'));
    $$('.tabpanel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    state.activeTab = name;
    const panel = $(`.tabpanel[data-panel="${name}"]`);
    if (panel) panel.classList.add('active');
    // Move the single prompt-host into the now-active tab's mount point.
    placePrompt();
    // Styles belong to text-to-image only; hide them on Edit Image / Create variants.
    updateStylesVisibility();
  }
  function bindTabs() {
    $$('#input-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    });
  }

  // Make a given input tab visible & active. selectTab() runs placePrompt() +
  // updateStylesVisibility() for us.
  function activateInputTab(name) {
    selectTab(name);
  }

  // Bring an editor into view so the user sees the image was loaded.
  function focusEditor(sel) {
    const node = $(sel);
    if (node && typeof node.scrollIntoView === 'function') {
      try { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { node.scrollIntoView(); }
    }
  }

  // ---------------------------------------------------------------- gallery hand-off
  // From a result image in the feed: load it into the Edit Image (inpaint) tab,
  // ready to paint a mask. Accepts a same-origin output URL.
  function sendToInpaint(url) {
    if (!url) return;
    activateInputTab('inpaint');
    loadInpaintImage(url);
    focusEditor('#inpaint-editor');
  }
  // From a result image in the feed: load it into the Create variants (uov) tab.
  function sendToVariants(url) {
    if (!url) return;
    activateInputTab('uov');
    loadUovImage(url);
    focusEditor('#uov-preview');
  }

  // dropzones (visual upload affordance; engine wiring is progressive/non-blocking)
  function bindDropzones() {
    $$('.dropzone').forEach((dz) => {
      const key = dz.dataset.drop;
      const file = $(`input[type="file"][data-file="${key}"]`);
      if (!file) return;
      dz.addEventListener('click', () => file.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.classList.remove('drag');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) showDropPreview(dz, e.dataTransfer.files[0]);
      });
      file.addEventListener('change', () => { if (file.files[0]) showDropPreview(dz, file.files[0]); });
    });
  }
  function showDropPreview(dz, file) {
    const reader = new FileReader();
    reader.onload = () => { dz.innerHTML = ''; dz.append(el('img', { src: reader.result, alt: file.name })); };
    reader.readAsDataURL(file);
  }

  // ---------------------------------------------------------------- inpaint mask editor (Feature 2)
  // Load a source image onto a display canvas and let the user paint a mask over
  // it (mouse + touch). The mask is kept on a separate offscreen canvas at the
  // image's NATIVE resolution (black background, white strokes) so the exported
  // PNG lines up exactly with the source image sent to the engine.
  const inpaint = {
    img: null,            // HTMLImageElement (the loaded source)
    natW: 0, natH: 0,     // native pixel dimensions
    dispW: 0, dispH: 0,   // on-screen canvas pixel dimensions
    scale: 1,             // dispW / natW
    maskCanvas: null,     // offscreen, native resolution (black + white strokes)
    maskCtx: null,
    canvas: null,         // visible display canvas
    ctx: null,
    painting: false,
    last: null,           // last pointer point in native coords
    brush: 40,            // brush diameter in DISPLAY pixels
    erase: false,
    hasMask: false,
  };
  const INPAINT_MAX_DISP = 640; // cap the display width so it fits the column

  function bindInpaint() {
    inpaint.canvas = $('#inpaint-canvas');
    if (!inpaint.canvas) return;
    inpaint.ctx = inpaint.canvas.getContext('2d');

    const dz = $('#inpaint-dropzone');
    const file = $('#inpaint-file');
    if (dz && file) {
      dz.addEventListener('click', () => file.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.classList.remove('drag');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) loadInpaintFile(f);
      });
      file.addEventListener('change', () => { if (file.files[0]) loadInpaintFile(file.files[0]); });
    }

    const brush = $('#inpaint-brush');
    const brushOut = $('#inpaint-brush-out');
    if (brush) {
      const upd = () => { inpaint.brush = Number(brush.value); if (brushOut) brushOut.textContent = String(inpaint.brush); };
      brush.addEventListener('input', upd);
      upd();
    }
    const brushBtn = $('#inpaint-brush-btn');
    const eraseBtn = $('#inpaint-erase-btn');
    const setTool = (erasing) => {
      inpaint.erase = erasing;
      if (brushBtn) { brushBtn.classList.toggle('active', !erasing); brushBtn.setAttribute('aria-pressed', String(!erasing)); }
      if (eraseBtn) { eraseBtn.classList.toggle('active', erasing); eraseBtn.setAttribute('aria-pressed', String(erasing)); }
    };
    if (brushBtn) brushBtn.addEventListener('click', () => setTool(false));
    if (eraseBtn) eraseBtn.addEventListener('click', () => setTool(true));

    const clearBtn = $('#inpaint-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', clearInpaintMask);

    // painting (pointer events cover mouse + touch + pen)
    const c = inpaint.canvas;
    c.addEventListener('pointerdown', onInpaintDown);
    c.addEventListener('pointermove', onInpaintMove);
    window.addEventListener('pointerup', onInpaintUp);
    c.addEventListener('pointerleave', () => { /* keep painting if button held; pointerup ends it */ });
  }

  function loadInpaintFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => loadInpaintImage(reader.result);
    reader.readAsDataURL(file);
  }

  // Load an image into the inpaint editor from a File's data URL, a same-origin
  // output URL (e.g. "outputs/x.png"), or an already-decoded HTMLImageElement.
  // Both the dropzone's File path (via loadInpaintFile) and the gallery hand-off
  // (sendToInpaint) funnel through here so a loaded image always lands the same way.
  function loadInpaintImage(imgOrUrl) {
    if (!imgOrUrl) return;
    if (imgOrUrl instanceof HTMLImageElement && imgOrUrl.complete && (imgOrUrl.naturalWidth || imgOrUrl.width)) {
      setupInpaintImage(imgOrUrl);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';            // same-origin outputs, but keeps the canvas exportable
    img.onload = () => setupInpaintImage(img);
    img.src = (imgOrUrl instanceof HTMLImageElement) ? imgOrUrl.src : outputUrl(imgOrUrl);
  }

  function setupInpaintImage(img) {
    inpaint.img = img;
    inpaint.natW = img.naturalWidth || img.width;
    inpaint.natH = img.naturalHeight || img.height;
    if (!inpaint.natW || !inpaint.natH) return;

    // display size: cap width, preserve aspect ratio
    const scale = Math.min(1, INPAINT_MAX_DISP / inpaint.natW);
    inpaint.scale = scale;
    inpaint.dispW = Math.max(1, Math.round(inpaint.natW * scale));
    inpaint.dispH = Math.max(1, Math.round(inpaint.natH * scale));

    inpaint.canvas.width = inpaint.dispW;
    inpaint.canvas.height = inpaint.dispH;
    inpaint.canvas.style.width = inpaint.dispW + 'px';
    inpaint.canvas.style.height = inpaint.dispH + 'px';

    // offscreen mask at native resolution. We keep it TRANSPARENT-background with
    // opaque-white strokes: that makes a translucent display overlay trivial
    // (source-in only tints the painted pixels), and we composite the strokes
    // over a black background only at export time to produce the PNG the engine
    // wants (white = inpaint, black = keep).
    inpaint.maskCanvas = document.createElement('canvas');
    inpaint.maskCanvas.width = inpaint.natW;
    inpaint.maskCanvas.height = inpaint.natH;
    inpaint.maskCtx = inpaint.maskCanvas.getContext('2d');
    inpaint.maskCtx.clearRect(0, 0, inpaint.natW, inpaint.natH);
    inpaint.hasMask = false;

    // reveal editor, hide dropzone
    const editor = $('#inpaint-editor');
    const dz = $('#inpaint-dropzone');
    if (editor) editor.classList.remove('hidden');
    if (dz) dz.classList.add('hidden');

    redrawInpaint();
  }

  // map a pointer event to native-resolution image coordinates
  function inpaintEventPoint(e) {
    const rect = inpaint.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (inpaint.canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (inpaint.canvas.height / rect.height);
    // convert display px -> native px
    return { x: x / inpaint.scale, y: y / inpaint.scale };
  }

  function paintStroke(from, to) {
    if (!inpaint.maskCtx) return;
    const ctx = inpaint.maskCtx;
    // brush radius is given in display px; convert to native px
    const r = Math.max(1, (inpaint.brush / 2) / inpaint.scale);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = r * 2;
    if (inpaint.erase) {
      // erase = remove painted pixels back to transparent
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.fillStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = '#fff';
      inpaint.hasMask = true;
    }
    ctx.beginPath();
    if (from) { ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); }
    // also stamp a dot so single taps paint
    ctx.beginPath();
    ctx.arc(to.x, to.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    redrawInpaint();
  }

  function onInpaintDown(e) {
    if (!inpaint.img) return;
    e.preventDefault();
    inpaint.painting = true;
    try { inpaint.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const p = inpaintEventPoint(e);
    inpaint.last = p;
    paintStroke(null, p);
  }
  function onInpaintMove(e) {
    if (!inpaint.painting) return;
    e.preventDefault();
    const p = inpaintEventPoint(e);
    paintStroke(inpaint.last, p);
    inpaint.last = p;
  }
  function onInpaintUp() {
    inpaint.painting = false;
    inpaint.last = null;
  }

  // draw the source image plus a translucent overlay of the painted mask
  function redrawInpaint() {
    if (!inpaint.ctx || !inpaint.img) return;
    const ctx = inpaint.ctx;
    ctx.clearRect(0, 0, inpaint.dispW, inpaint.dispH);
    ctx.drawImage(inpaint.img, 0, 0, inpaint.dispW, inpaint.dispH);
    if (inpaint.maskCanvas && inpaint.hasMask) {
      // tint white mask pixels with a translucent accent overlay
      const tmp = document.createElement('canvas');
      tmp.width = inpaint.dispW; tmp.height = inpaint.dispH;
      const tctx = tmp.getContext('2d');
      tctx.drawImage(inpaint.maskCanvas, 0, 0, inpaint.dispW, inpaint.dispH);
      // keep only the painted (white) areas, recolor them
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = 'rgba(124, 92, 255, 0.55)';
      tctx.fillRect(0, 0, inpaint.dispW, inpaint.dispH);
      ctx.drawImage(tmp, 0, 0);
    }
  }

  function clearInpaintMask() {
    if (!inpaint.maskCtx) return;
    inpaint.maskCtx.clearRect(0, 0, inpaint.natW, inpaint.natH);
    inpaint.hasMask = false;
    redrawInpaint();
  }

  // Has the user loaded an image and painted at least some mask?
  function inpaintReady() { return !!(inpaint.img && inpaint.hasMask); }
  function inpaintHasImage() { return !!inpaint.img; }

  // Build the generate payload pieces at native resolution.
  function inpaintPayload() {
    if (!inpaint.img || !inpaint.maskCanvas) return null;
    // source image at native resolution
    const src = document.createElement('canvas');
    src.width = inpaint.natW; src.height = inpaint.natH;
    src.getContext('2d').drawImage(inpaint.img, 0, 0, inpaint.natW, inpaint.natH);

    // mask PNG: black background, white where painted, exact native size. We
    // composite the transparent-bg stroke canvas onto an opaque black fill.
    const mask = document.createElement('canvas');
    mask.width = inpaint.natW; mask.height = inpaint.natH;
    const mctx = mask.getContext('2d');
    mctx.fillStyle = '#000';
    mctx.fillRect(0, 0, inpaint.natW, inpaint.natH);
    mctx.drawImage(inpaint.maskCanvas, 0, 0);

    // NOTE: no inpaint-specific prompt — inpainting uses the MAIN positive prompt,
    // which the engine already applies. There is exactly one prompt box in the UI.
    return {
      input_mode: 'inpaint',
      inpaint_image: src.toDataURL('image/png'),
      inpaint_mask: mask.toDataURL('image/png'),
    };
  }

  // re-localize anything in the inpaint editor that isn't a plain data-i18n node
  function refreshInpaintI18n() { /* brush-size value + tool labels are static/data-i18n */ }

  // ---------------------------------------------------------------- create variants (uov)
  // Load a source image and, on Generate, send it back to the engine in "uov"
  // (Upscale/Vary) mode with a Vary (Subtle|Strong) method so the engine produces
  // variations of the uploaded image using the main positive/negative prompt.
  const uov = {
    img: null,            // HTMLImageElement (the loaded source)
    natW: 0, natH: 0,     // native pixel dimensions
  };

  function bindUov() {
    const dz = $('#uov-dropzone');
    const file = $('#uov-file');
    if (dz && file) {
      dz.addEventListener('click', () => file.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.classList.remove('drag');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) loadUovFile(f);
      });
      file.addEventListener('change', () => { if (file.files[0]) loadUovFile(file.files[0]); });
    }
  }

  function loadUovFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => loadUovImage(reader.result);
    reader.readAsDataURL(file);
  }

  // Load a source image into the Create-variants editor from a File's data URL,
  // a same-origin output URL, or an already-decoded HTMLImageElement. Both the
  // dropzone's File path (via loadUovFile) and the gallery hand-off (sendToVariants)
  // funnel through here.
  function loadUovImage(imgOrUrl) {
    if (!imgOrUrl) return;
    if (imgOrUrl instanceof HTMLImageElement && imgOrUrl.complete && (imgOrUrl.naturalWidth || imgOrUrl.width)) {
      setupUovImage(imgOrUrl);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';            // same-origin outputs, but keeps the canvas exportable
    img.onload = () => setupUovImage(img);
    img.src = (imgOrUrl instanceof HTMLImageElement) ? imgOrUrl.src : outputUrl(imgOrUrl);
  }

  function setupUovImage(img) {
    uov.img = img;
    uov.natW = img.naturalWidth || img.width;
    uov.natH = img.naturalHeight || img.height;
    if (!uov.natW || !uov.natH) { uov.img = null; return; }

    const preview = $('#uov-preview');
    const previewImg = $('#uov-preview-img');
    const dz = $('#uov-dropzone');
    if (previewImg) { previewImg.src = img.src; previewImg.alt = ''; }
    if (preview) preview.classList.remove('hidden');
    if (dz) dz.classList.add('hidden');
  }

  function uovHasImage() { return !!uov.img; }

  // Build the generate payload pieces for "Create variants" at native resolution.
  // Uses the MAIN positive/negative prompt, which the engine already applies.
  function uovPayload() {
    if (!uov.img) return null;
    // re-encode the source image at native resolution so the engine gets clean bytes
    const src = document.createElement('canvas');
    src.width = uov.natW; src.height = uov.natH;
    src.getContext('2d').drawImage(uov.img, 0, 0, uov.natW, uov.natH);
    const strengthSel = $('#uov-strength');
    const strong = strengthSel && strengthSel.value === 'strong';
    return {
      input_mode: 'uov',
      uov_image: src.toDataURL('image/png'),
      uov_method: strong ? 'Vary (Strong)' : 'Vary (Subtle)',
    };
  }

  // ---------------------------------------------------------------- range / input bindings
  function bindControls() {
    bindRange('image_number', (v) => String(parseInt(v)));
    bindRange('refiner_switch', (v) => Number(v).toFixed(2));
    bindRange('guidance_scale', (v) => Number(v).toFixed(1));
    bindRange('sharpness', (v) => Number(v).toFixed(1));
    bindRange('clip_skip', (v) => String(parseInt(v)));
    bindRange('ip_weight', (v) => Number(v).toFixed(2));

    $('#seed_random').addEventListener('change', (e) => { $('#seed').disabled = e.target.checked; });

    $('#style-search').addEventListener('input', (e) => renderStyles(e.target.value));
    $('#styles-clear').addEventListener('click', () => setStyles([]));

    const resClear = $('#results-clear');
    if (resClear) resClear.addEventListener('click', clearResults);

    elGen.addEventListener('click', onGenerate);
    elStop.addEventListener('click', onStop);
    elSkip.addEventListener('click', onSkip);

    // Live time estimate: refresh (debounced) whenever a setting that affects it
    // changes. #performance is a segmented radiogroup whose radios are rebuilt by
    // applyOptions, so we delegate on the stable container; #image_number and
    // #aspect_ratio are stable elements.
    const perfHost = $('#performance');
    if (perfHost) {
      perfHost.addEventListener('change', () => scheduleEstimate());
      perfHost.addEventListener('click', () => scheduleEstimate());
    }
    const imgNum = $('#image_number');
    if (imgNum) {
      imgNum.addEventListener('input', () => scheduleEstimate());
      imgNum.addEventListener('change', () => scheduleEstimate());
    }
    const aspect = $('#aspect_ratio');
    if (aspect) aspect.addEventListener('change', () => scheduleEstimate());
    // Steps override (advanced) also feeds the estimate when set to a real value.
    const stepsEl = $('#steps_override');
    if (stepsEl) {
      stepsEl.addEventListener('input', () => scheduleEstimate());
      stepsEl.addEventListener('change', () => scheduleEstimate());
    }

    // language selector
    const langSel = $('#lang-select');
    if (langSel) langSel.addEventListener('change', (e) => setLanguage(e.target.value));
  }

  // ---------------------------------------------------------------- health watch
  async function checkHealth(first = false) {
    try {
      const h = await apiGet('health');
      // Device-aware ready text: "NVIDIA CUDA: Engine Ready", "Apple Metal: …",
      // "CPU: …". Unknown/absent device -> the plain "Engine Ready" message.
      const devKey = engineReadyKey(h && h.device);
      if (devKey) setEngine('online', devKey, { ready: t('engine.ready') });
      else setEngine('online', 'engine.ready', null);
      if (h && h.version) $('#foot-version').textContent = 'v' + h.version;
      hideBanner();
      return true;
    } catch (e) {
      if (e.status && e.status >= 500 || e.status === 503) {
        setEngine('starting', 'engine.starting', null);
        showBannerKey('info', 'banner.engine.starting', null, true);
      } else {
        setEngine('offline', 'engine.offline', null);
        if (first) showBannerKey('error', 'banner.engine.unreachable', null, false);
      }
      return false;
    }
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    // i18n + mode first, so everything renders translated and in the right mode.
    initMode();
    await setLanguage(pickInitialLang(), false);

    initPerformanceSection();
    initModelsAccordion();
    buildLoraRows();
    bindAddLora();
    bindControls();
    bindTabs();
    bindDropzones();
    bindInpaint();
    bindUov();
    // Place the single prompt-host into the correct mount for the booted mode/tab.
    placePrompt();
    // Set initial Styles visibility for the current mode / active tab.
    updateStylesVisibility();

    // Restore the accumulating results feed from a previous session.
    loadResults();
    renderFeed();

    // Render fallbacks immediately so the UI is interactive even if engine is slow.
    applyOptions(FALLBACK);
    applyTranslations();   // re-apply over the freshly injected DOM

    const ok = await checkHealth(true);

    try {
      const opts = await apiGet('options');
      applyOptions(opts);
    } catch (e) {
      console.warn('options load failed; using fallbacks', e);
      if (ok) showBannerKey('warn', 'banner.options.limited', null, false);
    }

    // load the default preset (Standard)
    await loadPreset(state.activePreset);

    // Demo page hand-off: preselect a style chosen on the Examples gallery. Run
    // AFTER loadPreset (which may set its own styles) so the chosen style wins,
    // and after options so the style exists in state.styles.
    applyPendingStyle();

    // Reconnect to a generation that was running before a page refresh.
    await recoverTask();

    // Show the initial live time estimate now that options + preset are loaded.
    refreshEstimate();

    // keep an eye on the engine; back off polling after it is up
    setInterval(() => { if (!state.generating) checkHealth(false); }, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
