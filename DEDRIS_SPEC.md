# DedrisGenAI — Build Contract (SPEC)

This file is the **single source of truth** shared by all build agents. Do not contradict it.
Goal: a total rebrand of a Fooocus-based image generator into **DedrisGenAI**, replacing the
Gradio UI with a **PHP web UI**, keeping the Python+PyTorch engine (renamed) as the generation
backend, with portable launchers for **Windows/NVIDIA-CUDA** and **macOS/MPS**.

The product is built around **3 model presets**: **Standard**, **Anime**, **Realistic**.

---

## 1. Final folder structure (already created)

```
DedrisGenAI/
├─ engine/                 # Python generation engine (renamed Fooocus core). Runs with CWD=engine/.
│  ├─ modules/             # backend logic (async_worker, config, flags, sdxl_styles, ...)
│  ├─ ldm_patched/         # ComfyUI-based diffusion backend
│  ├─ extras/              # BLIP, GroundingDINO, expansion, etc.
│  ├─ presets/             # default.json (=Standard), anime.json, realistic.json
│  ├─ sdxl_styles/         # style json files
│  ├─ wildcards/  language/  css/  javascript/  tests/  models/  docker/
│  ├─ args_manager.py  launch.py  webui.py(legacy gradio)  version.py(NEW)  ...
│  └─ server.py            # NEW: HTTP API service that the PHP UI calls
├─ webui/                  # NEW: PHP web UI (replaces Gradio)
│  ├─ public/              # document root served by PHP: index.php + assets/
│  │  ├─ index.php
│  │  └─ assets/{css,js,img}
│  ├─ api/                 # PHP endpoints that PROXY to the engine (browser only talks to PHP)
│  ├─ lib/                 # PHP helpers (EngineClient, Config)
│  └─ _legacy_reference/   # old php stub (reference only; do not ship)
├─ runtimes/               # portable runtimes (provisioned by launchers; mostly gitignored)
│  ├─ php/                 # portable PHP per-OS (small enough to commit where possible)
│  └─ python/              # portable Python+torch (auto-provisioned on first run; gitignored)
├─ launchers/              # bootstrap scripts (shared logic)
├─ docs/                   # documentation
├─ start.bat               # ROOT entry — Windows / NVIDIA CUDA
├─ start.command           # ROOT entry — macOS / MPS
├─ README.md               # top-level project readme (DedrisGenAI)
└─ DEDRIS_SPEC.md          # this file
```

Engine path facts (do NOT break):
- `engine/launch.py` sets `root = dir(__file__)`, `os.chdir(root)`, `sys.path.append(root)`.
- Model paths resolve relative to `engine/modules/` → e.g. checkpoints at `engine/models/checkpoints/`.
- Presets load via CWD: `engine/presets/<name>.json`.

---

## 2. Branding rename map (Fooocus → DedrisGenAI)

Apply **everywhere**, but keep functionality identical.

| From | To |
|---|---|
| `Fooocus` (brand text, titles, UI) | `DedrisGenAI` |
| `FOOOCUS` (constants) | `DEDRISGENAI` / `DEDRIS` |
| `fooocus` (user-facing/value strings) | `dedrisgenai` |
| file `engine/fooocus_version.py` | `engine/version.py` (keep symbol `version`); update the only importer (`launch.py`, and any `import fooocus_version`) |
| Style family **"Fooocus V2/Enhance/Sharp/Masterpiece/Photograph/Negative/Cinematic/Semi Realistic/..."** | **"DedrisGenAI V2/Enhance/Sharp/..."** |
| `sdxl_styles/sdxl_styles_fooocus.json` | `sdxl_styles/sdxl_styles_dedris.json` (rename file + every `"name"`) |
| code constant `fooocus_expansion = 'Fooocus V2'` (modules/sdxl_styles.py) | `'DedrisGenAI V2'` |
| `MetadataScheme.FOOOCUS = 'fooocus'` (modules/flags.py) | `MetadataScheme.DEDRIS = 'dedrisgenai'` (update all refs incl. meta_parser.py, async_worker.py, webui.py) |
| config key `path_fooocus_expansion`, folder `prompt_expansion/fooocus_expansion` | `path_dedris_expansion`, `prompt_expansion/dedris_expansion` (update config.py, launch.py, sdxl_styles.py) |
| temp dir name `tempfile.gettempdir()/fooocus` | `.../dedrisgenai` |

### Rebrand rules
- **Do not** rename third-party model **download filenames** that come from external URLs
  (e.g. `juggernautXL_v8Rundiffusion.safetensors`, the HF `.bin`) — only local folder/key names.
- **Style display names must stay consistent** across: the style json, all `presets/*.json`
  `default_styles`, and the `fooocus_expansion` constant. The "… V2" style drives prompt
  expansion — keep that link intact under the new name.
- Keep GitHub upstream URLs in `entry_with_update.py`/`launch.py` pointing at this repo's own
  remote where they reference self-update; otherwise leave external HF/torch URLs untouched.
- After editing, **verify**: `grep -ri "fooocus" engine/ | grep -v _legacy_reference` returns only
  unavoidable cases (document any), and `python3 -m py_compile` succeeds on every changed `.py`.

### Version
`engine/version.py`:
```python
version = '1.0.0'  # DedrisGenAI — engine based on Fooocus 2.5.5
```

---

## 3. The 3 presets (keep ONLY these three)

Keep: `engine/presets/default.json` (**Standard**), `anime.json` (**Anime**), `realistic.json` (**Realistic**).
**Delete** the other presets: `lcm.json`, `lightning.json`, `playground_v2.5.json`, `pony_v6.json`, `sai.json`.
(`default.json` must keep its filename — `config.py` loads `presets/default.json` as the base.)

Preset → UI label mapping the UI/API must use:
```
default   -> "Standard"
anime     -> "Anime"
realistic -> "Realistic"
```
Each preset's `default_styles` must use the **renamed** DedrisGenAI style names.

---

## 4. UI control inventory (PHP UI must replicate Fooocus)

Source of truth for behavior: `engine/webui.py` + `engine/modules/async_worker.py` + `engine/modules/flags.py`.

**Top bar:** brand "DedrisGenAI" logo/title, Preset selector (Standard/Anime/Realistic).

**Core generation (always visible):**
- Positive prompt (textarea), Negative prompt (textarea)
- Generate button, Stop, Skip
- Performance (radio): `Quality, Speed, Extreme Speed, Lightning, Hyper-SD`
- Aspect ratio (radio, values from `flags.sdxl_aspect_ratios`, default from preset `default_aspect_ratio`)
- Image number (1–32; note: Extreme/Lightning/Hyper restrict some features)
- Seed (random toggle + numeric)
- Output format (`png|jpeg|webp`)
- Styles (multi-select, searchable list from styles API; defaults from preset)

**Models panel:**
- Base model (checkpoint dropdown), Refiner (dropdown), Refiner switch (slider)
- 5× LoRA rows: [enabled, name dropdown, weight -2..2]

**Advanced panel:**
- Guidance Scale / CFG (1–30), Image Sharpness (0–30)
- Sampler (`flags.sampler_list`), Scheduler (`flags.scheduler_list`), Steps override
- VAE, CLIP skip (1–12)

**Results area:** gallery of generated images, live progress bar + status text + preview image.

**Image-input tabs (replicate layout; wire what the engine API exposes):**
`Upscale/Vary (uov)`, `Image Prompt`, `Inpaint/Outpaint`, `Describe`, `Enhance`, `Metadata`.
Core text-to-image + presets + advanced + LoRA + gallery are **required**; the image-input tabs
should be present in the layout and wired progressively.

No "Fooocus" text anywhere in the UI.

---

## 5. API contract

Two layers. **Browser → PHP** (user-facing). **PHP → Engine** (localhost only). The PHP `api/*`
endpoints mirror the engine endpoints 1:1 and just forward JSON (avoids CORS, hides the engine).

- **PHP UI** listens on `127.0.0.1:8888` (env `DEDRIS_UI_PORT`, default 8888).
- **Engine** listens on `127.0.0.1:7866` (env `DEDRIS_ENGINE_PORT`, default 7866).

### Engine HTTP service (`engine/server.py`)
JSON over HTTP. Endpoints (all under `/api`):

- `GET /api/health` → `{ "status":"ok", "version":"1.0.0", "device":"cuda|mps|cpu" }`
- `GET /api/options` → everything the UI needs to render:
  ```json
  {
    "presets": ["Standard","Anime","Realistic"],
    "performances": ["Quality","Speed","Extreme Speed","Lightning","Hyper-SD"],
    "aspect_ratios": ["704*1408", ...],
    "samplers": ["euler", ...],
    "schedulers": ["normal","karras", ...],
    "output_formats": ["png","jpeg","webp"],
    "styles": [{"name":"DedrisGenAI V2","preview":"<url|null>"}, ...],
    "models": {"checkpoints":[...], "loras":["None", ...], "vaes":["Default (model)", ...]}
  }
  ```
- `GET /api/preset?name=Standard|Anime|Realistic` → the preset's default settings (model, styles,
  cfg, sharpness, sampler, scheduler, performance, aspect_ratio, negative_prompt, loras).
- `POST /api/generate` → body = generation params (see below). Returns `{ "task_id":"<id>" }`.
- `GET /api/progress?task_id=ID` → `{ "state":"pending|running|done|error|stopped",
  "progress":0-100, "preview":"<dataURL|null>", "message":"...",
  "images":["/outputs/...png", ...] (when done) }`
- `POST /api/stop` body `{ "task_id":"ID" }` → cancel current/queued task.
- `GET /outputs/<path>` → serve generated image files.

**`POST /api/generate` body (superset; missing fields fall back to the active preset):**
```json
{
  "preset": "Standard",
  "prompt": "", "negative_prompt": "",
  "style_selections": ["DedrisGenAI V2","DedrisGenAI Sharp"],
  "performance": "Speed",
  "aspect_ratio": "1152*896",
  "image_number": 2,
  "output_format": "png",
  "seed": -1,
  "sharpness": 2.0,
  "guidance_scale": 4.0,
  "base_model": "juggernautXL_v8Rundiffusion.safetensors",
  "refiner_model": "None", "refiner_switch": 0.5,
  "loras": [[true,"sd_xl_offset_example-lora_1.0.safetensors",0.1], [true,"None",1.0], ...],
  "sampler": "dpmpp_2m_sde_gpu", "scheduler": "karras",
  "steps_override": -1, "vae": "Default (model)", "clip_skip": 1
}
```

The engine maps this onto the same `AsyncTask`/`worker` flow used by `webui.py` so results are
identical to Fooocus. Long-running model load happens once at engine startup.

### PHP proxy endpoints (in `webui/api/`)
Mirror the engine: `health.php, options.php, preset.php, generate.php, progress.php, stop.php`
(+ an image passthrough). Each reads JSON from the request, forwards to
`http://127.0.0.1:<DEDRIS_ENGINE_PORT>/api/...`, returns the engine's JSON verbatim.
Config (ports) read from env with the defaults above; expose a tiny `webui/lib/Config.php`.

---

## 6. Launchers & portable runtimes

Two root entry points; both: (1) ensure portable runtimes exist (provision on first run),
(2) start the engine service, (3) start the PHP UI server, (4) open the browser at
`http://127.0.0.1:8888`.

- **`start.bat`** (Windows / NVIDIA CUDA):
  - Uses portable PHP from `runtimes/php/win/php.exe` (provision if missing).
  - Provisions portable Python into `runtimes/python/win/` if missing, installs torch **CUDA**
    (`--extra-index-url https://download.pytorch.org/whl/cu121`) + `engine/requirements_versions.txt`.
  - Starts engine: `runtimes\python\win\python.exe engine\server.py` (CWD=engine).
  - Starts PHP UI: `php -S 127.0.0.1:8888 -t webui\public webui\public\router.php`.
- **`start.command`** (macOS / Apple Silicon MPS):
  - Portable PHP from `runtimes/php/mac/php` (provision if missing; static build).
  - Python venv in `runtimes/python/mac/` with torch (default CPU/MPS wheels; sets
    `PYTORCH_ENABLE_MPS_FALLBACK=1`).
  - Same engine + PHP UI startup, `chmod +x` friendly, double-clickable.

Shared bootstrap logic lives in `launchers/` (e.g. `launchers/common.sh`, `launchers/common.bat`).
Provisioning must be **idempotent** and require **no system install** from the user.
Engine env: set `DEDRIS_ENGINE_PORT`; UI env: `DEDRIS_UI_PORT`, `DEDRIS_ENGINE_PORT`.

> NOTE: torch+python (GBs) are NOT committed — they are auto-provisioned into `runtimes/python/`
> on first launch. Portable PHP binaries may be committed when small enough; otherwise provisioned.

---

## 7. Conventions

- Ports: UI 8888, engine 7866 (override via env).
- No "Fooocus" anywhere user-visible. Comments/history may keep "based on Fooocus" attribution
  (LICENSE/credits) — that is allowed and encouraged for license compliance.
- PHP: plain PHP (no Composer deps required to run); namespace `DedrisGenAI\UI`.
- Keep the engine runnable the legacy way too (`python launch.py`) for debugging.
- This environment has no torch/models and PHP must be provisioned — only the **PHP UI** will be
  launched/verified here; full generation is validated by the user on a CUDA/MPS machine.
