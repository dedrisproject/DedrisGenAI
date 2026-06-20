/* DedrisGenAI — front-end controller
 * Vanilla JS, no framework. Talks only to same-origin /api/* (the PHP proxy).
 *
 * API endpoints used (mirror DEDRIS_SPEC.md §5):
 *   GET  /api/health                      -> { status, version, device }
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
 * Three UI concerns layered on top of the original controller:
 *   1. Simple / Advanced mode  — toggles html.mode-simple|mode-advanced.
 *   2. i18n (it/en/de/fr/es)   — applies data-i18n* attributes from a dictionary.
 *   3. Rich progress UX        — elapsed timer, indeterminate bar, stage hints,
 *                                first-run note, localized state messages.
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
  const LANGS = ['it', 'en', 'de', 'fr', 'es'];
  const DEFAULT_LANG = (document.documentElement.dataset.defaultLang) || 'it';
  const LS_LANG = 'dedris.lang';
  const LS_MODE = 'dedris.mode';
  const LS_TASK = 'dedris.task';   // in-flight task id, so a page refresh can reconnect

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
    // styles grid (placeholders carry translated alt/title)
    renderStyles($('#style-search') ? $('#style-search').value : '');
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
  }

  // ============================================================== Simple/Advanced mode
  function applyMode(mode, persist = true) {
    mode = (mode === 'advanced') ? 'advanced' : 'simple';
    const root = document.documentElement;
    root.classList.toggle('mode-simple', mode === 'simple');
    root.classList.toggle('mode-advanced', mode === 'advanced');
    $$('.mode-toggle .mode-btn').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    state.mode = mode;
    if (persist) { try { localStorage.setItem(LS_MODE, mode); } catch (_) {} }
  }
  function initMode() {
    let mode = 'simple';
    try { const m = localStorage.getItem(LS_MODE); if (m === 'advanced' || m === 'simple') mode = m; } catch (_) {}
    applyMode(mode, false);
    $$('.mode-toggle .mode-btn').forEach((b) => {
      b.addEventListener('click', () => applyMode(b.dataset.mode));
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
    activePreset: 'Standard',
    activeTab: 'text',
    taskId: null,
    polling: false,
    pollTimer: null,
    generating: false,
    mode: 'simple',
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
    enginePillKey: null, enginePillPrefix: '',
  };
  const LORA_COUNT = 5;

  // rotating stage hints shown while progress is indeterminate
  const HINT_KEYS = ['progress.preparing', 'progress.loading_model', 'progress.generating'];

  // ---------------------------------------------------------------- engine status / banner
  const elStatus = $('#engine-status');
  const elBanner = $('#banner');
  const elBannerText = $('#banner-text');
  const elBannerSpin = $('#banner-spinner');

  function setEngine(status, key, prefix) {
    state.enginePillKey = key;
    state.enginePillPrefix = prefix || '';
    elStatus.className = 'engine-pill ' + status;
    $('.txt', elStatus).textContent = (prefix || '') + t(key);
  }
  function refreshEnginePill() {
    if (state.enginePillKey) {
      $('.txt', elStatus).textContent = (state.enginePillPrefix || '') + t(state.enginePillKey);
    }
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

  function fillSegmented(container, items, name, checkedValue) {
    container.innerHTML = '';
    (items || []).forEach((it) => {
      const id = name + '-' + String(it).replace(/[^a-z0-9]+/gi, '_');
      const lab = el('label', { for: id },
        el('input', { type: 'radio', name, id, value: it }),
        el('span', {}, it));
      if (it === checkedValue) $('input', lab).checked = true;
      container.append(lab);
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

    fillSegmented($('#preset'), o.presets || FALLBACK.presets, 'preset', state.activePreset);
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
  const elGallery = $('#gallery');

  function setGenLabel() {
    const txt = $('.txt', elGen);
    const ico = $('.ico', elGen);
    if (txt) txt.textContent = state.generating ? t('btn.generating') : t('btn.generate');
    if (ico) ico.textContent = state.generating ? '⏳' : '✨';
  }
  function setGenerating(on) {
    state.generating = on;
    elGen.disabled = on;
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
  function renderGallery(images) {
    elGallery.innerHTML = '';
    (images || []).forEach((img) => {
      const url = outputUrl(img);
      const a = el('a', { href: '#', onclick: (e) => { e.preventDefault(); openLightbox(url); } },
        el('img', { src: url, alt: 'Generated image', loading: 'lazy' }));
      elGallery.append(a);
    });
    if (images && images.length) setPreview(outputUrl(images[0]));
  }

  async function onGenerate() {
    if (state.generating) return;
    setGenerating(true);
    startTimers();
    setIndeterminate(true);                 // start animated immediately
    setProgress(0, 'progress.submitting', true);
    setIndeterminate(true);
    elGallery.innerHTML = '';
    try {
      const params = gatherParams();
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

      if (st === 'done' || st === 'finished' || st === 'completed') {
        const imgs = data.images || [];
        renderGallery(imgs);
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
      showBannerKey('info', 'banner.task.resumed', null, true);
      pollProgress();
    } else if (st === 'done' || st === 'finished' || st === 'completed') {
      // Finished while we were away — show its results.
      const imgs = data.images || [];
      renderGallery(imgs);
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
  function openLightbox(url) { $('#lightbox-img').src = url; lb.classList.add('show'); }
  function closeLightbox() { lb.classList.remove('show'); }
  $('#lightbox-close').addEventListener('click', closeLightbox);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

  // ---------------------------------------------------------------- tabs
  function bindTabs() {
    $$('#input-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('#input-tabs .tab').forEach((t2) => t2.classList.remove('active'));
        $$('.tabpanel').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        const name = tab.dataset.tab;
        state.activeTab = name;
        const panel = $(`.tabpanel[data-panel="${name}"]`);
        if (panel) panel.classList.add('active');
      });
    });
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

    elGen.addEventListener('click', onGenerate);
    elStop.addEventListener('click', onStop);
    elSkip.addEventListener('click', onSkip);

    // language selector
    const langSel = $('#lang-select');
    if (langSel) langSel.addEventListener('change', (e) => setLanguage(e.target.value));
  }

  // ---------------------------------------------------------------- health watch
  async function checkHealth(first = false) {
    try {
      const h = await apiGet('health');
      const prefix = (h && h.device ? h.device.toUpperCase() + ' · ' : '');
      setEngine('online', 'engine.ready', prefix);
      if (h && h.version) $('#foot-version').textContent = 'v' + h.version;
      hideBanner();
      return true;
    } catch (e) {
      if (e.status && e.status >= 500 || e.status === 503) {
        setEngine('starting', 'engine.starting', '');
        showBannerKey('info', 'banner.engine.starting', null, true);
      } else {
        setEngine('offline', 'engine.offline', '');
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

    buildLoraRows();
    bindControls();
    bindTabs();
    bindDropzones();

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

    // keep an eye on the engine; back off polling after it is up
    setInterval(() => { if (!state.generating) checkHealth(false); }, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
