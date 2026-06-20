"""
DedrisGenAI engine HTTP service.

A long-running, localhost-only HTTP API that drives the SAME generation flow the
legacy Gradio UI (``webui.py``) uses, so results are byte-for-byte identical to
the legacy engine. The PHP web UI (``webui/``) is the only client; it proxies
browser requests here (so no CORS is required, though a permissive header is
added defensively).

Design
------
* The crux of fidelity is the ``modules.async_worker.AsyncTask`` argument list.
  ``webui.py`` builds a flat ``ctrls`` list and hands it to
  ``worker.AsyncTask(args=...)``; the worker reverses it and ``pop()``s field by
  field. We rebuild that exact list, in the exact order, filling every control
  the API does not expose with the very same defaults the Gradio widgets use
  (see ``build_async_task_args`` and the ARG MAPPING comment block there).
* Startup mirrors ``launch.py`` *without* running pip: it sets the required env
  vars (``PYTORCH_ENABLE_MPS_FALLBACK`` etc.), chdir's to the engine root,
  downloads/links the default models the active preset needs, primes the file
  caches, then imports ``modules.async_worker`` which auto-starts the background
  worker thread. Model weights themselves are lazily loaded by the worker on the
  first generate.
* ``from webui import *`` is deliberately NOT used: that call ends in
  ``shared.gradio_root.launch(...)`` which would block and start Gradio. The
  worker only touches ``shared.gradio_root`` inside a try/except print, so
  leaving it ``None`` is harmless.

HTTP stack
----------
FastAPI + uvicorn. Gradio (already a hard dependency of the engine) depends on
both, so they are guaranteed present in the provisioned runtime — no new deps.
If FastAPI is ever absent the module still imports for inspection; the failure
only surfaces when ``main()`` runs.

Run
---
    cd engine
    python server.py            # binds 127.0.0.1:7866 (env DEDRIS_ENGINE_PORT)

Endpoints (all JSON, see docs/ARCHITECTURE.md):
    GET  /api/health
    GET  /api/options
    GET  /api/preset?name=Standard|Anime|Realistic
    POST /api/generate
    GET  /api/progress?task_id=ID
    POST /api/stop
    GET  /outputs/<path>
"""

import os
import sys
import ssl
import time
import uuid
import base64
import threading

# ---------------------------------------------------------------------------
# Engine path + environment bootstrap (mirrors launch.py, WITHOUT pip installs)
# ---------------------------------------------------------------------------

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.append(ROOT)
os.chdir(ROOT)

# Same env launch.py sets and the worker/model backend depends on.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")

# Allow self-signed / corporate proxies for the one-time model downloads, same
# relaxation launch.py applies.
try:
    ssl._create_default_https_context = ssl._create_unverified_context
except Exception:
    pass

ENGINE_HOST = "127.0.0.1"
ENGINE_PORT = int(os.environ.get("DEDRIS_ENGINE_PORT", "7866"))

# preset file (on disk) -> UI/API label, per SPEC §3.
PRESET_FILE_TO_LABEL = {"default": "Standard", "anime": "Anime", "realistic": "Realistic"}
PRESET_LABEL_TO_FILE = {v: k for k, v in PRESET_FILE_TO_LABEL.items()}
PRESET_LABELS = ["Standard", "Anime", "Realistic"]

# Populated by bootstrap(); kept module-global so request handlers can reach them.
_BOOTSTRAPPED = False
_BOOTSTRAP_LOCK = threading.Lock()
worker = None          # modules.async_worker
config = None          # modules.config
flags = None           # modules.flags
sdxl_styles = None     # modules.sdxl_styles

# task_id -> AsyncTask, so /api/progress and /api/stop can find live tasks.
_TASKS = {}
_TASKS_LOCK = threading.Lock()

# Finished tasks are cached (bounded) so their final result survives a UI page
# refresh: once a task finishes it is removed from _TASKS, but its terminal
# progress payload (state + images) stays retrievable here for a while.
_DONE_CACHE = {}
_DONE_ORDER = []
_DONE_MAX = 32


def _remember_done(task_id, result):
    """Store a terminal /api/progress payload so a later poll (e.g. after a page
    refresh) can still retrieve the finished task's images instead of erroring."""
    with _TASKS_LOCK:
        if task_id not in _DONE_CACHE:
            _DONE_ORDER.append(task_id)
            while len(_DONE_ORDER) > _DONE_MAX:
                old = _DONE_ORDER.pop(0)
                _DONE_CACHE.pop(old, None)
        _DONE_CACHE[task_id] = result


# ---------------------------------------------------------------------------
# Version / device detection (cheap, works before models are loaded)
# ---------------------------------------------------------------------------

def get_version():
    """Robust version import from version.py."""
    try:
        from version import version  # type: ignore
        return version
    except Exception:
        return "0.0.0"


def detect_device():
    """Return 'cuda' | 'mps' | 'cpu' without requiring models to be loaded."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


# ---------------------------------------------------------------------------
# Heavy bootstrap: model download/link + worker thread (mirrors launch.py tail)
# ---------------------------------------------------------------------------

def bootstrap():
    """Idempotently prepare the engine: download default models, prime caches,
    and start the background worker thread. Safe to call multiple times."""
    global _BOOTSTRAPPED, worker, config, flags, sdxl_styles
    if _BOOTSTRAPPED:
        return
    with _BOOTSTRAP_LOCK:
        if _BOOTSTRAPPED:
            return

        import modules.config as _config
        import modules.flags as _flags
        import modules.sdxl_styles as _sdxl_styles

        os.environ.setdefault("GRADIO_TEMP_DIR", _config.temp_path)
        os.environ.setdefault("U2NET_HOME", _config.path_inpaint)

        # Replicate launch.py's model provisioning (download/link the files the
        # active preset references). Network only; no pip. Tolerate failure so the
        # service can still answer metadata endpoints offline.
        try:
            from modules.model_loader import load_file_from_url
            from modules.util import get_file_from_folder_list

            # VAE-approx previews + the prompt-expansion model. Copied verbatim
            # from launch.py rather than imported, because importing launch.py
            # would run prepare_environment() (pip) and `from webui import *`
            # (which launches Gradio and blocks).
            vae_approx_filenames = [
                ('xlvaeapp.pth', 'https://huggingface.co/lllyasviel/misc/resolve/main/xlvaeapp.pth'),
                ('vaeapp_sd15.pth', 'https://huggingface.co/lllyasviel/misc/resolve/main/vaeapp_sd15.pt'),
                ('xl-to-v1_interposer-v4.0.safetensors',
                 'https://huggingface.co/mashb1t/misc/resolve/main/xl-to-v1_interposer-v4.0.safetensors'),
            ]
            for file_name, url in vae_approx_filenames:
                try:
                    load_file_from_url(url=url, model_dir=_config.path_vae_approx, file_name=file_name)
                except Exception as e:
                    print(f"[DedrisGenAI] vae_approx download skipped ({file_name}): {e}")

            try:
                expansion_dir = getattr(_config, "path_dedris_expansion", None)
                load_file_from_url(
                    url="https://huggingface.co/lllyasviel/misc/resolve/main/fooocus_expansion.bin",
                    model_dir=expansion_dir,
                    file_name="pytorch_model.bin",
                )
            except Exception as e:
                print(f"[DedrisGenAI] expansion model download skipped: {e}")

            # Checkpoint / lora downloads from the active preset.
            for file_name, url in dict(_config.checkpoint_downloads).items():
                try:
                    model_dir = os.path.dirname(get_file_from_folder_list(file_name, _config.paths_checkpoints))
                    load_file_from_url(url=url, model_dir=model_dir, file_name=file_name)
                except Exception as e:
                    print(f"[DedrisGenAI] checkpoint download skipped ({file_name}): {e}")
            for file_name, url in dict(getattr(_config, "lora_downloads", {})).items():
                try:
                    model_dir = os.path.dirname(get_file_from_folder_list(file_name, _config.paths_loras))
                    load_file_from_url(url=url, model_dir=model_dir, file_name=file_name)
                except Exception as e:
                    print(f"[DedrisGenAI] lora download skipped ({file_name}): {e}")
        except Exception as e:
            print(f"[DedrisGenAI] model provisioning skipped: {e}")

        # Prime the file lists + hash caches (launch.py does these two).
        try:
            _config.update_files()
            from modules.hash_cache import init_cache
            init_cache(_config.model_filenames, _config.paths_checkpoints,
                       _config.lora_filenames, _config.paths_loras)
        except Exception as e:
            print(f"[DedrisGenAI] cache init skipped: {e}")

        # Importing async_worker auto-starts the daemon worker thread (it calls
        # threading.Thread(target=worker, daemon=True).start() at module load).
        import modules.async_worker as _worker

        config = _config
        flags = _flags
        sdxl_styles = _sdxl_styles
        worker = _worker
        _BOOTSTRAPPED = True
        print(f"[DedrisGenAI] engine bootstrapped (device={detect_device()}, version={get_version()})")


# ---------------------------------------------------------------------------
# Options / presets helpers
# ---------------------------------------------------------------------------

def _style_preview_url(style_name):
    """Map a style display name to its preview image URL. Filename follows the
    same slug rule as javascript/script.js and tools/generate_style_previews.py:
    ``name.lower().replace(' ', '_') + '.jpg'``.

    Resolution order (a generated preview wins over the shipped sample):
      1. sdxl_styles/previews/<slug>.jpg -> /styles/previews/<slug>.jpg
      2. sdxl_styles/samples/<slug>.jpg  -> /styles/samples/<slug>.jpg
      3. None
    Returns a URL the PHP layer can serve, or None when neither exists."""
    if not style_name:
        return None
    fname = style_name.lower().replace(" ", "_") + ".jpg"
    if os.path.exists(os.path.join(ROOT, "sdxl_styles", "previews", fname)):
        return f"/styles/previews/{fname}"
    if os.path.exists(os.path.join(ROOT, "sdxl_styles", "samples", fname)):
        return f"/styles/samples/{fname}"
    # The expansion style (DedrisGenAI V2) maps to dedrisgenai_v2.jpg via the rule
    # above; keep an explicit fallback so the V2 preview still shows if the name
    # ever drifts from the file name.
    expansion_name = getattr(sdxl_styles, "dedris_expansion_style", None)
    if style_name == expansion_name:
        if os.path.exists(os.path.join(ROOT, "sdxl_styles", "previews", "dedrisgenai_v2.jpg")):
            return "/styles/previews/dedrisgenai_v2.jpg"
        if os.path.exists(os.path.join(ROOT, "sdxl_styles", "samples", "dedrisgenai_v2.jpg")):
            return "/styles/samples/dedrisgenai_v2.jpg"
    return None


def build_options():
    bootstrap()
    styles_payload = []
    # legal_style_names = [expansion, 'Random Style'] + sorted style keys.
    for name in sdxl_styles.legal_style_names:
        styles_payload.append({"name": name, "preview": _style_preview_url(name)})

    checkpoints = list(config.model_filenames)
    loras = ["None"] + list(config.lora_filenames)
    vaes = [flags.default_vae] + list(config.vae_filenames)

    return {
        "presets": PRESET_LABELS,
        "performances": flags.Performance.values(),
        "aspect_ratios": list(config.available_aspect_ratios),
        "samplers": list(flags.sampler_list),
        "schedulers": list(flags.scheduler_list),
        "output_formats": list(flags.OutputFormat.list()),
        "styles": styles_payload,
        "models": {"checkpoints": checkpoints, "loras": loras, "vaes": vaes},
        "defaults": {
            "preset": PRESET_FILE_TO_LABEL.get(_active_preset_file(), "Standard"),
            "max_lora_number": config.default_max_lora_number,
            "max_image_number": config.default_max_image_number,
        },
    }


def _active_preset_file():
    """The preset file config.py loaded at import (args_manager.args.preset or
    'default' when none was passed)."""
    p = getattr(config, "preset", None)
    if isinstance(p, str) and p in PRESET_FILE_TO_LABEL:
        return p
    return "default"


def load_preset(label):
    """Return a normalized defaults dict for a UI label (Standard/Anime/Realistic)."""
    bootstrap()
    file_name = PRESET_LABEL_TO_FILE.get(label)
    if file_name is None:
        raise ValueError(f"unknown preset '{label}' (use one of {PRESET_LABELS})")
    content = config.try_get_preset_content(file_name)  # {} if missing/unreadable

    # Normalize loras to [[enabled, name, weight], ...] (presets sometimes use
    # the legacy [name, weight] 2-tuple form).
    raw_loras = content.get("default_loras", config.default_loras)
    loras = []
    for y in raw_loras:
        if isinstance(y, (list, tuple)) and len(y) == 3:
            loras.append([bool(y[0]), str(y[1]), float(y[2])])
        elif isinstance(y, (list, tuple)) and len(y) == 2:
            loras.append([True, str(y[0]), float(y[1])])

    def g(key, fallback):
        return content.get(key, fallback)

    return {
        "preset": label,
        "base_model": g("default_model", config.default_base_model_name),
        "refiner_model": g("default_refiner", config.default_refiner_model_name),
        "refiner_switch": g("default_refiner_switch", 0.5),
        "loras": loras,
        "guidance_scale": g("default_cfg_scale", config.default_cfg_scale),
        "sharpness": g("default_sample_sharpness", config.default_sample_sharpness),
        "sampler": g("default_sampler", config.default_sampler),
        "scheduler": g("default_scheduler", config.default_scheduler),
        "performance": g("default_performance", config.default_performance),
        "prompt": g("default_prompt", config.default_prompt),
        "negative_prompt": g("default_prompt_negative", config.default_prompt_negative),
        "style_selections": g("default_styles", config.default_styles),
        "aspect_ratio": g("default_aspect_ratio", config.default_aspect_ratio),
        "output_format": config.default_output_format,
        "image_number": config.default_image_number,
        "vae": g("default_vae", config.default_vae),
        "clip_skip": g("default_clip_skip", config.default_clip_skip),
        "steps_override": g("default_overwrite_step", config.default_overwrite_step),
    }


# ---------------------------------------------------------------------------
# AsyncTask argument assembly — the fidelity-critical part
# ---------------------------------------------------------------------------

def _data_url_to_np(data_url, mode="RGB"):
    """Decode a base64 data URL (or raw base64) into an HxWxC uint8 numpy array.
    Returns None if absent/invalid. Used for the inpaint image + brushed mask."""
    if not data_url or not isinstance(data_url, str):
        return None
    try:
        import base64 as _b64
        from io import BytesIO
        import numpy as np
        from PIL import Image
        raw = data_url.split(",", 1)[1] if data_url.startswith("data:") else data_url
        img = Image.open(BytesIO(_b64.b64decode(raw))).convert(mode)
        return np.array(img)
    except Exception:
        return None


def build_async_task_args(body):
    """Build the EXACT positional ``args`` list ``modules.async_worker.AsyncTask``
    expects, filling everything the API doesn't expose with the same default the
    corresponding Gradio widget uses in webui.py.

    AsyncTask reverses the list then pops field by field, which consumes the list
    in the SAME forward order it was built. webui.get_task() pops the leading
    ``currentTask`` placeholder first, so the list below begins at
    ``generate_image_grid`` — i.e. it equals ``ctrls[1:]`` from webui.py.

    Defaults from preset come first so explicit body fields override them.

      ===================================================================
      AsyncTask arg order (index -> value -> source)
      ===================================================================
       0  generate_image_grid              False  (webui default)
       1  prompt                           body / preset
       2  negative_prompt                  body / preset
       3  style_selections                 body / preset (list)
       4  performance_selection            body / preset
       5  aspect_ratios_selection          body / preset
       6  image_number                     body / config default
       7  output_format                    body / config default
       8  image_seed                       body seed (-1 => random int)
       9  read_wildcards_in_order          False  (webui default)
      10  sharpness                        body / preset
      11  guidance_scale (cfg)             body / preset
      12  base_model                       body / preset
      13  refiner_model                    body / preset
      14  refiner_switch                   body / preset
      15..(12+3*N)  lora rows: [enabled,name,weight] x default_max_lora_number
                                           body / preset (padded with True/None/1.0)
          input_image_checkbox             False  (no image-input via API yet)
          current_tab                      'uov'  (webui default tab key)
          uov_method                       config.default_uov_method (Disabled)
          uov_input_image                  None
          outpaint_selections              [] (empty)
          inpaint_input_image              None
          inpaint_additional_prompt        ''
          inpaint_mask_image_upload        None
          disable_preview                  config.default_black_out_nsfw
          disable_intermediate_results     Performance.has_restricted_features(perf)
          disable_seed_increment           False
          black_out_nsfw                   config.default_black_out_nsfw
          adm_scaler_positive              1.5  (webui default)
          adm_scaler_negative              0.8  (webui default)
          adm_scaler_end                   0.3  (webui default)
          adaptive_cfg                     config.default_cfg_tsnr
          clip_skip                        body / config.default_clip_skip
          sampler_name                     body / preset
          scheduler_name                   body / preset
          vae_name                         body / config.default_vae
          overwrite_step                   body steps_override / config.default_overwrite_step
          overwrite_switch                 config.default_overwrite_switch
          overwrite_width                  -1
          overwrite_height                 -1
          overwrite_vary_strength          -1
          overwrite_upscale_strength       config.default_overwrite_upscale
          mixing_image_prompt_and_vary_upscale  False
          mixing_image_prompt_and_inpaint       False
          debugging_cn_preprocessor        False
          skipping_cn_preprocessor         False
          canny_low_threshold              64
          canny_high_threshold             128
          refiner_swap_method              flags.refiner_swap_method ('joint')
          controlnet_softness              0.25
          freeu_enabled                    False
          freeu_b1                         1.01
          freeu_b2                         1.02
          freeu_s1                         0.99
          freeu_s2                         0.95
          debugging_inpaint_preprocessor   False
          inpaint_disable_initial_latent   False
          inpaint_engine                   config.default_inpaint_engine_version
          inpaint_strength                 1.0
          inpaint_respective_field         0.618
          inpaint_advanced_masking_checkbox  config.default_inpaint_advanced_masking_checkbox
          invert_mask_checkbox             False
          inpaint_erode_or_dilate          0
          (if not --disable-image-log) save_final_enhanced_image_only
                                           config.default_save_only_final_enhanced_image
          (if not --disable-metadata)   save_metadata_to_images
                                           config.default_save_metadata_to_images
          (if not --disable-metadata)   metadata_scheme
                                           config.default_metadata_scheme
          ip_ctrls: per controlnet image (default_controlnet_image_count):
                   [ip_image(None), ip_stop, ip_weight, ip_type] x N
          debugging_dino                   False
          dino_erode_or_dilate             0
          debugging_enhance_masks_checkbox False
          enhance_input_image              None
          enhance_checkbox                 config.default_enhance_checkbox (False)
          enhance_uov_method               config.default_enhance_uov_method (Disabled)
          enhance_uov_processing_order     config.default_enhance_uov_processing_order
          enhance_uov_prompt_type          config.default_enhance_uov_prompt_type
          enhance_ctrls: per enhance tab (default_enhance_tabs): 16 fields each,
                   all disabled defaults mirroring webui.py
      ===================================================================
    """
    import args_manager

    # Start from the active preset's defaults, override with body fields.
    label = body.get("preset") or PRESET_FILE_TO_LABEL.get(_active_preset_file(), "Standard")
    if label not in PRESET_LABEL_TO_FILE:
        label = "Standard"
    preset = load_preset(label)

    def pick(key, default=None):
        v = body.get(key)
        return preset.get(key, default) if v is None else v

    args = []

    # 0
    args.append(bool(body.get("generate_image_grid", False)))
    # 1-3
    args.append(str(pick("prompt", "")))
    args.append(str(pick("negative_prompt", "")))
    style_selections = pick("style_selections", [])
    if not isinstance(style_selections, list):
        style_selections = list(style_selections) if style_selections else []
    args.append(style_selections)
    # 4
    args.append(str(pick("performance", config.default_performance)))
    # 5 aspect ratio — the worker expects the Gradio label format "W×H ..."
    # (see config.add_ratio / async_worker width,height parsing). The API/presets
    # carry the raw "W*H" form, so normalize it here.
    _ar = str(pick("aspect_ratio", config.default_aspect_ratio))
    if "×" not in _ar:
        try:
            _ar = config.add_ratio(_ar)
        except Exception:
            pass
    args.append(_ar)
    # 6
    args.append(int(pick("image_number", config.default_image_number)))
    # 7
    args.append(str(pick("output_format", config.default_output_format)))
    # 8 seed (-1 / missing => random within the engine's seed space)
    import random
    seed = body.get("seed", -1)
    try:
        seed = int(seed)
    except (TypeError, ValueError):
        seed = -1
    if seed < 0:
        seed = random.randint(0, constants_max_seed())
    args.append(seed)
    # 9
    args.append(False)  # read_wildcards_in_order
    # 10
    args.append(float(pick("sharpness", config.default_sample_sharpness)))
    # 11
    args.append(float(pick("guidance_scale", config.default_cfg_scale)))
    # 12-14
    args.append(str(pick("base_model", config.default_base_model_name)))
    args.append(str(pick("refiner_model", config.default_refiner_model_name)))
    args.append(float(pick("refiner_switch", 0.5)))

    # lora rows, flattened to enabled, name, weight, ... (default_max_lora_number rows)
    max_loras = config.default_max_lora_number
    body_loras = body.get("loras")
    src_loras = body_loras if isinstance(body_loras, list) else preset.get("loras", [])
    norm = []
    for row in src_loras:
        if isinstance(row, (list, tuple)) and len(row) == 3:
            norm.append([bool(row[0]), str(row[1]), float(row[2])])
        elif isinstance(row, (list, tuple)) and len(row) == 2:
            norm.append([True, str(row[0]), float(row[1])])
    while len(norm) < max_loras:
        norm.append([True, "None", 1.0])
    norm = norm[:max_loras]
    for enabled, name, weight in norm:
        args.append(enabled)
        args.append(name)
        args.append(weight)

    # image-input controls. Inpaint: the UI sends the source image + a brushed
    # mask (white = region to regenerate) as base64 data URLs; we decode them into
    # the {'image','mask'} dict Fooocus' worker expects and switch to the inpaint tab.
    inpaint_img = None
    inpaint_msk = None
    if str(body.get("input_mode", "")) == "inpaint":
        inpaint_img = _data_url_to_np(body.get("inpaint_image"), "RGB")
        if inpaint_img is not None:
            inpaint_msk = _data_url_to_np(body.get("inpaint_mask"), "RGB")
    do_inpaint = inpaint_img is not None
    if do_inpaint:
        # The worker reads inpaint_input_image['mask'][:, :, 0], so the mask must be a
        # HxWx3 array matching the image. Synthesize/resize defensively.
        import numpy as np
        if inpaint_msk is None:
            inpaint_msk = np.zeros_like(inpaint_img)
        elif inpaint_msk.shape[:2] != inpaint_img.shape[:2]:
            try:
                from PIL import Image
                inpaint_msk = np.array(Image.fromarray(inpaint_msk).resize(
                    (inpaint_img.shape[1], inpaint_img.shape[0])))
            except Exception:
                inpaint_msk = np.zeros_like(inpaint_img)

    args.append(bool(do_inpaint))                       # input_image_checkbox
    args.append("inpaint" if do_inpaint else "uov")     # current_tab
    args.append(config.default_uov_method)              # uov_method
    args.append(None)                                   # uov_input_image
    args.append([])                                     # outpaint_selections
    args.append({"image": inpaint_img, "mask": inpaint_msk} if do_inpaint else None)  # inpaint_input_image
    args.append(str(body.get("inpaint_prompt", "") or ""))  # inpaint_additional_prompt
    args.append(None)                                   # inpaint_mask_image_upload

    # developer / advanced block
    perf = str(pick("performance", config.default_performance))
    args.append(bool(config.default_black_out_nsfw))  # disable_preview
    args.append(bool(flags.Performance.has_restricted_features(perf)))  # disable_intermediate_results
    args.append(False)              # disable_seed_increment
    args.append(bool(config.default_black_out_nsfw))  # black_out_nsfw
    args.append(1.5)                # adm_scaler_positive
    args.append(0.8)                # adm_scaler_negative
    args.append(0.3)                # adm_scaler_end
    args.append(float(config.default_cfg_tsnr))       # adaptive_cfg
    args.append(int(pick("clip_skip", config.default_clip_skip)))  # clip_skip
    args.append(str(pick("sampler", config.default_sampler)))      # sampler_name
    args.append(str(pick("scheduler", config.default_scheduler)))  # scheduler_name
    args.append(str(pick("vae", config.default_vae)))             # vae_name

    steps_override = body.get("steps_override", preset.get("steps_override", config.default_overwrite_step))
    try:
        steps_override = int(steps_override)
    except (TypeError, ValueError):
        steps_override = config.default_overwrite_step
    args.append(steps_override)                       # overwrite_step
    args.append(int(config.default_overwrite_switch)) # overwrite_switch
    args.append(-1)                 # overwrite_width
    args.append(-1)                 # overwrite_height
    args.append(-1.0)               # overwrite_vary_strength
    args.append(float(config.default_overwrite_upscale))  # overwrite_upscale_strength
    args.append(False)              # mixing_image_prompt_and_vary_upscale
    args.append(False)              # mixing_image_prompt_and_inpaint
    args.append(False)              # debugging_cn_preprocessor
    args.append(False)              # skipping_cn_preprocessor
    args.append(64)                 # canny_low_threshold
    args.append(128)                # canny_high_threshold
    args.append(flags.refiner_swap_method)  # refiner_swap_method ('joint')
    args.append(0.25)               # controlnet_softness

    # freeu_ctrls
    args.append(False)              # freeu_enabled
    args.append(1.01)               # freeu_b1
    args.append(1.02)               # freeu_b2
    args.append(0.99)               # freeu_s1
    args.append(0.95)               # freeu_s2

    # inpaint_ctrls
    args.append(False)              # debugging_inpaint_preprocessor
    args.append(False)              # inpaint_disable_initial_latent
    args.append(config.default_inpaint_engine_version)  # inpaint_engine
    args.append(1.0)                # inpaint_strength
    args.append(0.618)              # inpaint_respective_field
    args.append(bool(config.default_inpaint_advanced_masking_checkbox))  # inpaint_advanced_masking_checkbox
    args.append(False)              # invert_mask_checkbox
    args.append(0)                  # inpaint_erode_or_dilate

    # conditional image-log / metadata controls (same guards as webui.py)
    if not args_manager.args.disable_image_log:
        args.append(bool(config.default_save_only_final_enhanced_image))  # save_final_enhanced_image_only
    if not args_manager.args.disable_metadata:
        args.append(bool(config.default_save_metadata_to_images))  # save_metadata_to_images
        args.append(config.default_metadata_scheme)                # metadata_scheme

    # ip_ctrls: 4 fields per controlnet image (image, stop, weight, type)
    for i in range(1, config.default_controlnet_image_count + 1):
        args.append(None)                                    # ip_image
        args.append(config.default_ip_stop_ats.get(i, flags.default_parameters[flags.default_ip][0]))   # ip_stop
        args.append(config.default_ip_weights.get(i, flags.default_parameters[flags.default_ip][1]))    # ip_weight
        args.append(config.default_ip_types.get(i, flags.default_ip))                                    # ip_type

    # dino / enhance masks
    args.append(False)              # debugging_dino
    args.append(0)                  # dino_erode_or_dilate
    args.append(False)              # debugging_enhance_masks_checkbox

    # enhance block (single-image inputs)
    args.append(None)               # enhance_input_image
    args.append(bool(config.default_enhance_checkbox))            # enhance_checkbox
    args.append(config.default_enhance_uov_method)               # enhance_uov_method
    args.append(config.default_enhance_uov_processing_order)     # enhance_uov_processing_order
    args.append(config.default_enhance_uov_prompt_type)          # enhance_uov_prompt_type

    # enhance_ctrls: 16 fields per enhance tab, all disabled defaults (mirror webui.py)
    for _ in range(config.default_enhance_tabs):
        args.append(False)                                       # enhance_enabled
        args.append("")                                         # enhance_mask_dino_prompt_text
        args.append("")                                         # enhance_prompt
        args.append("")                                         # enhance_negative_prompt
        args.append(config.default_enhance_inpaint_mask_model)  # enhance_mask_model
        args.append(config.default_inpaint_mask_cloth_category) # enhance_mask_cloth_category
        args.append(config.default_inpaint_mask_sam_model)      # enhance_mask_sam_model
        args.append(0.25)                                      # enhance_mask_text_threshold
        args.append(0.3)                                       # enhance_mask_box_threshold
        args.append(config.default_sam_max_detections)         # enhance_mask_sam_max_detections
        args.append(False)                                     # enhance_inpaint_disable_initial_latent
        args.append(config.default_inpaint_engine_version)     # enhance_inpaint_engine
        args.append(1.0)                                       # enhance_inpaint_strength
        args.append(0.618)                                     # enhance_inpaint_respective_field
        args.append(0)                                         # enhance_inpaint_erode_or_dilate
        args.append(False)                                     # enhance_mask_invert

    return args, seed


def constants_max_seed():
    try:
        import modules.constants as constants
        return int(constants.MAX_SEED)
    except Exception:
        return 2 ** 63 - 1


# ---------------------------------------------------------------------------
# Generate / progress / stop
# ---------------------------------------------------------------------------

# Per-preset model download state, so the UI can show a "downloading model" bar
# the moment a preset is selected (not only when generating).
_PRESET_DL = {}            # label -> {state, message, done, total, event}
_PRESET_DL_LOCK = threading.Lock()


def _preset_missing(label):
    """[(file_name, url, model_dir), ...] of the preset's models not present on disk."""
    file_name = PRESET_LABEL_TO_FILE.get(label)
    missing = []
    if not file_name:
        return missing
    content = config.try_get_preset_content(file_name)  # {} if missing/unreadable
    from modules.util import get_file_from_folder_list
    for fn, url in (content.get("checkpoint_downloads") or {}).items():
        dest = get_file_from_folder_list(fn, config.paths_checkpoints)
        if not os.path.isfile(dest):
            missing.append((fn, url, os.path.dirname(dest)))
    for fn, url in (content.get("lora_downloads") or {}).items():
        dest = get_file_from_folder_list(fn, config.paths_loras)
        if not os.path.isfile(dest):
            missing.append((fn, url, os.path.dirname(dest)))
    for fn, url in (content.get("embeddings_downloads") or {}).items():
        dest = os.path.join(config.path_embeddings, fn)
        if not os.path.isfile(dest):
            missing.append((fn, url, config.path_embeddings))
    return missing


def _public_dl_status(label, st):
    return {"preset": label, "state": st.get("state", "idle"),
            "message": st.get("message", ""), "done": st.get("done", 0),
            "total": st.get("total", 0), "ready": st.get("state") == "ready"}


def _ensure_preset(label):
    """Idempotently make sure a preset's models are present. Returns a status dict.
    The first call for a preset with missing models starts a background download;
    repeated calls just report the current state (no duplicate downloads)."""
    bootstrap()
    if label not in PRESET_LABEL_TO_FILE:
        return {"preset": label, "state": "error", "ready": False,
                "message": f"unknown preset '{label}'", "done": 0, "total": 0}
    with _PRESET_DL_LOCK:
        st = _PRESET_DL.get(label)
        if st and st.get("state") in ("downloading", "ready"):
            return _public_dl_status(label, st)
        try:
            missing = _preset_missing(label)
        except Exception:
            missing = []
        if not missing:
            st = {"state": "ready", "message": "Model ready", "done": 0, "total": 0,
                  "event": threading.Event()}
            st["event"].set()
            _PRESET_DL[label] = st
            return _public_dl_status(label, st)
        st = {"state": "downloading", "done": 0, "total": len(missing),
              "message": f"Downloading model for {label} ({missing[0][0]}) …",
              "event": threading.Event()}
        _PRESET_DL[label] = st
    threading.Thread(target=_run_preset_download, args=(label, missing, st), daemon=True).start()
    return _public_dl_status(label, st)


def _run_preset_download(label, missing, st):
    try:
        from modules.model_loader import load_file_from_url
        total = len(missing)
        for i, (fn, url, model_dir) in enumerate(missing, start=1):
            st["done"] = i - 1
            st["message"] = (f"Downloading {fn} ({i}/{total}) for {label} — "
                             f"first use, this can take a few minutes…")
            load_file_from_url(url=url, model_dir=model_dir, file_name=fn)
        st["done"] = total
        st["state"] = "ready"
        st["message"] = "Model ready"
    except Exception:
        import traceback
        traceback.print_exc()
        last = traceback.format_exc().strip().splitlines()
        st["state"] = "error"
        st["message"] = "Model download failed: " + (last[-1] if last else "unknown error")
    finally:
        st["event"].set()


def _wait_then_queue(task, label):
    """Wait until the preset's models finish downloading, then enqueue the task."""
    st = _PRESET_DL.get(label)
    ev = st.get("event") if st else None
    if ev:
        while not ev.wait(timeout=1.0):
            task._download_msg = (_PRESET_DL.get(label) or {}).get("message", task._download_msg)
        task._download_msg = (_PRESET_DL.get(label) or {}).get("message")
    final = _PRESET_DL.get(label) or {}
    if final.get("state") == "ready":
        task._download_msg = None
        worker.async_tasks.append(task)
    else:
        task.last_exception = final.get("message", "model download failed")
        task._download_msg = None
        task.yields.append(['finish', task.results])


def start_generation(body):
    bootstrap()
    args, seed = build_async_task_args(body)
    task = worker.AsyncTask(args=args)
    task_id = uuid.uuid4().hex
    with _TASKS_LOCK:
        _TASKS[task_id] = task
    # Reset the global interrupt flag the same way webui.generate_clicked does.
    try:
        import ldm_patched.modules.model_management as model_management
        with model_management.interrupt_processing_mutex:
            model_management.interrupt_processing = False
    except Exception:
        pass

    # Ensure the requested preset's models are present (they're downloaded on first
    # use of Anime/Realistic). _ensure_preset is idempotent and shares state with the
    # /api/ensure_model endpoint the UI calls on preset selection, so there is no
    # duplicate download. The task is enqueued once the models are ready.
    label = body.get("preset") or PRESET_FILE_TO_LABEL.get(_active_preset_file(), "Standard")
    st = _ensure_preset(label)
    if st["state"] == "ready":
        worker.async_tasks.append(task)
    elif st["state"] == "error":
        task.last_exception = st.get("message", "model unavailable")
        task.yields.append(['finish', task.results])
    else:  # downloading
        task._download_msg = st.get("message")
        threading.Thread(target=_wait_then_queue, args=(task, label), daemon=True).start()
    return {"task_id": task_id, "seed": seed}


def _np_to_data_url(img):
    """Encode a preview numpy image (HWC RGB uint8) as a PNG data URL."""
    try:
        import numpy as np
        from PIL import Image
        import io
        if img is None or not isinstance(img, np.ndarray):
            return None
        pil = Image.fromarray(img.astype("uint8"))
        buf = io.BytesIO()
        pil.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/png;base64,{b64}"
    except Exception:
        return None


def _outputs_url_for(path):
    """Turn an absolute output file path into a /outputs/<rel> URL."""
    try:
        base = os.path.abspath(config.path_outputs)
        ap = os.path.abspath(path)
        if ap.startswith(base):
            rel = os.path.relpath(ap, base).replace(os.sep, "/")
            return f"/outputs/{rel}"
    except Exception:
        pass
    # Not under outputs (e.g. temp dir) — still expose basename via /outputs.
    return f"/outputs/{os.path.basename(str(path))}"


def get_progress(task_id):
    bootstrap()
    with _TASKS_LOCK:
        if task_id in _DONE_CACHE:
            return _DONE_CACHE[task_id]
        task = _TASKS.get(task_id)
    if task is None:
        return {"state": "unknown", "progress": 0, "preview": None,
                "message": "unknown task_id", "images": []}

    # Drain the yields queue, keeping the latest preview/progress and detecting
    # finish/results. This mirrors webui.generate_clicked's consumption loop.
    state = "running" if task.processing else "pending"
    progress = 0
    preview = None
    message = ""
    finished = False
    images = []

    while len(task.yields) > 0:
        flag, product = task.yields.pop(0)
        if flag == "preview":
            percentage, title, image = product
            progress = int(percentage)
            message = title
            if image is not None:
                preview = _np_to_data_url(image)
            state = "running"
        elif flag == "results":
            # intermediate results list (numpy or paths); keep going
            state = "running"
        elif flag == "finish":
            finished = True
            progress = 100
            results = product if isinstance(product, list) else []
            for r in results:
                if isinstance(r, str):
                    images.append(_outputs_url_for(r))
            break

    if finished:
        if task.last_stop == "stop":
            state = "stopped"
            message = message or "Stopped"
        elif not images:
            # The worker finished but produced no image — almost always a swallowed
            # exception inside the generation handler. Surface it instead of a
            # silent "done" so the UI shows what actually went wrong.
            state = "error"
            err = getattr(task, "last_exception", None)
            if err:
                tb_lines = [ln for ln in str(err).strip().splitlines() if ln.strip()]
                detail = " | ".join(tb_lines[-3:]) if tb_lines else str(err)
                message = f"Generation failed: {detail}"
            else:
                message = ("Generation finished without producing an image. "
                           "Check the engine log for the traceback "
                           "(on Colab: /content/dedris_engine.log).")
        else:
            state = "done"
            message = message or "Finished"
        with _TASKS_LOCK:
            _TASKS.pop(task_id, None)
        result = {"state": state, "progress": 100, "preview": preview,
                  "message": message, "images": images}
        _remember_done(task_id, result)
        return result

    # The task is waiting on a one-time model download (preset switch) before it
    # can be enqueued for the worker. Report it as a loading phase with a message.
    dl_msg = getattr(task, "_download_msg", None)
    if dl_msg:
        return {"state": "loading", "progress": max(progress, 1), "preview": preview,
                "message": dl_msg, "images": []}

    if task.last_stop == "stop":
        state = "stopped"
        message = message or "Stopping ..."
    elif task.last_stop == "skip":
        message = message or "Skipping ..."

    # Images already saved during this (possibly multi-image) run, so the UI can
    # show finished images progressively ("man mano") before the whole batch ends.
    running_images = []
    try:
        for r in (getattr(task, "results", []) or []):
            if isinstance(r, str):
                running_images.append(_outputs_url_for(r))
    except Exception:
        pass

    return {"state": state, "progress": progress, "preview": preview,
            "message": message or ("Running ..." if state == "running" else "Waiting for task to start ..."),
            "images": running_images}


def stop_task(task_id):
    """Cancel via the same mechanism webui's Stop button uses: set last_stop and
    interrupt current processing if the task is the one running."""
    bootstrap()
    with _TASKS_LOCK:
        task = _TASKS.get(task_id)
    if task is None:
        return {"state": "error", "message": "unknown task_id"}
    task.last_stop = "stop"
    if task.processing:
        try:
            import ldm_patched.modules.model_management as model_management
            model_management.interrupt_current_processing()
        except Exception:
            pass
    return {"state": "stopped", "message": "stop requested"}


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

def create_app():
    """Build the FastAPI app. Imported lazily so the module stays importable for
    inspection even if FastAPI is missing from the env."""
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, FileResponse
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="DedrisGenAI Engine", version=get_version())

    # CORS not required (PHP proxies) but harmless and useful for direct debugging.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health():
        return {"status": "ok", "version": get_version(), "device": detect_device()}

    @app.get("/api/options")
    def options():
        try:
            return build_options()
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": str(e)})

    @app.get("/api/preset")
    def preset(name: str = "Standard"):
        try:
            return load_preset(name)
        except ValueError as e:
            return JSONResponse(status_code=400, content={"error": str(e)})
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": str(e)})

    @app.post("/api/generate")
    async def generate(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            return JSONResponse(status_code=400, content={"error": "body must be a JSON object"})
        try:
            return start_generation(body)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse(status_code=500, content={"error": str(e)})

    @app.get("/api/progress")
    def progress(task_id: str):
        try:
            return get_progress(task_id)
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": str(e)})

    @app.post("/api/stop")
    async def stop(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        task_id = body.get("task_id") if isinstance(body, dict) else None
        if not task_id:
            return JSONResponse(status_code=400, content={"error": "task_id required"})
        return stop_task(task_id)

    @app.post("/api/ensure_model")
    async def ensure_model(request: Request):
        """Start (or report) the download of a preset's models. Called by the UI on
        preset selection so a 'downloading model' bar can show before generating."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        label = (body or {}).get("preset") if isinstance(body, dict) else None
        label = label or PRESET_FILE_TO_LABEL.get(_active_preset_file(), "Standard")
        try:
            return _ensure_preset(label)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse(status_code=500, content={"error": str(e)})

    @app.get("/api/model_status")
    def model_status(preset: str = None):
        bootstrap()
        label = preset or PRESET_FILE_TO_LABEL.get(_active_preset_file(), "Standard")
        st = _PRESET_DL.get(label)
        if st:
            return _public_dl_status(label, st)
        # Not requested yet: report ready if already present, else idle.
        try:
            missing = _preset_missing(label)
        except Exception:
            missing = []
        return {"preset": label, "ready": not missing,
                "state": "ready" if not missing else "idle",
                "message": "Model ready" if not missing else "Model not downloaded yet",
                "done": 0, "total": len(missing)}

    @app.get("/outputs/{path:path}")
    def outputs(path: str):
        base = os.path.abspath(config.path_outputs)
        target = os.path.abspath(os.path.join(base, path))
        if not target.startswith(base) or not os.path.isfile(target):
            return JSONResponse(status_code=404, content={"error": "not found"})
        return FileResponse(target)

    @app.get("/styles/previews/{name}")
    def style_preview(name: str):
        base = os.path.abspath(os.path.join(ROOT, "sdxl_styles", "previews"))
        target = os.path.abspath(os.path.join(base, name))
        if not target.startswith(base) or not os.path.isfile(target):
            return JSONResponse(status_code=404, content={"error": "not found"})
        return FileResponse(target)

    @app.get("/styles/samples/{name}")
    def style_sample(name: str):
        base = os.path.abspath(os.path.join(ROOT, "sdxl_styles", "samples"))
        target = os.path.abspath(os.path.join(base, name))
        if not target.startswith(base) or not os.path.isfile(target):
            return JSONResponse(status_code=404, content={"error": "not found"})
        return FileResponse(target)

    return app


def main():
    print(f"[DedrisGenAI] starting engine on http://{ENGINE_HOST}:{ENGINE_PORT}")
    bootstrap()
    import uvicorn
    app = create_app()
    uvicorn.run(app, host=ENGINE_HOST, port=ENGINE_PORT, log_level="info")


if __name__ == "__main__":
    main()
