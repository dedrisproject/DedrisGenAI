# Folder structure

This document explains how the DedrisGenAI project is laid out on disk.

```
DedrisGenAI/
├─ engine/                 # Python generation engine (SDXL backend). Runs with CWD=engine/.
│  ├─ modules/             # backend logic (async_worker, config, flags, sdxl_styles, ...)
│  ├─ ldm_patched/         # ComfyUI-based diffusion backend
│  ├─ extras/              # BLIP, GroundingDINO, prompt expansion, etc.
│  ├─ presets/             # default.json (=Standard), anime.json, realistic.json
│  ├─ sdxl_styles/         # style json files
│  ├─ wildcards/  language/  css/  javascript/  tests/  models/  docker/
│  ├─ args_manager.py  launch.py  webui.py (legacy gradio)  version.py  ...
│  └─ server.py            # HTTP API service that the PHP UI calls
├─ webui/                  # PHP web UI (replaces the old Gradio UI)
│  ├─ public/              # document root served by PHP: index.php + assets/
│  │  ├─ index.php
│  │  └─ assets/{css,js,img}
│  ├─ api/                 # PHP endpoints that PROXY to the engine (browser only talks to PHP)
│  ├─ lib/                 # PHP helpers (EngineClient, Config)
│  └─ _legacy_reference/   # old php stub (reference only; not shipped)
├─ runtimes/               # portable runtimes (provisioned by launchers; mostly gitignored)
│  ├─ php/                 # portable PHP per-OS
│  └─ python/              # portable Python + torch (auto-provisioned on first run; gitignored)
├─ launchers/              # bootstrap scripts (shared logic)
├─ docs/                   # documentation (you are here)
├─ start.bat               # ROOT entry — Windows / NVIDIA CUDA
├─ start.command           # ROOT entry — macOS / MPS
├─ README.md               # top-level project readme
└─ DEDRIS_SPEC.md          # build contract / source of truth
```

## The two halves

DedrisGenAI is split into a **front end** (`webui/`, PHP) and a **back end** (`engine/`, Python).
They communicate over a local HTTP API. The portable PHP and Python interpreters that run them are
kept under `runtimes/`, and the launchers in the project root wire everything together.

## `engine/` — the generation engine

The engine is the Python + PyTorch image generation backend (based on Fooocus, see the project
README's Credits section). It always runs with its working directory set to `engine/`.

- **`server.py`** — the HTTP API service the PHP UI calls. This is the new entry point used by the
  launchers.
- **`launch.py`** — the legacy entry point, kept for debugging. It sets `root = dir(__file__)`,
  `os.chdir(root)`, and `sys.path.append(root)`, so all relative paths resolve inside `engine/`.
- **`webui.py`** — the legacy Gradio UI; kept as a behavior reference, not used in production.
- **`version.py`** — exposes the `version` symbol (e.g. `1.0.0`).
- **`modules/`** — core backend logic: the async worker, configuration, flags/enums, style handling, etc.
- **`ldm_patched/`** — the ComfyUI-based diffusion backend.
- **`extras/`** — auxiliary models and tools: BLIP (describe), GroundingDINO, prompt expansion, etc.
- **`presets/`** — the three shipped presets: `default.json` (Standard), `anime.json`, `realistic.json`.
- **`sdxl_styles/`** — style definition JSON files.
- **`models/`** — checkpoints, LoRAs, VAEs, inpaint/controlnet models, and so on. Most are downloaded
  on demand on first use.
- **`wildcards/`, `language/`, `css/`, `javascript/`, `tests/`, `docker/`** — wildcards for prompts,
  i18n strings, legacy assets, the test suite, and Docker support files.

### Engine path facts

These are important when running or debugging the engine directly:

- `engine/launch.py` sets the working directory to `engine/`, so all relative paths are rooted there.
- Model paths resolve relative to `engine/modules/`, e.g. checkpoints at `engine/models/checkpoints/`.
- Presets load via the working directory: `engine/presets/<name>.json`.

## `webui/` — the PHP web UI

The PHP front end that replaces the old Gradio UI. The browser only ever talks to this server.

- **`public/`** — the document root served by PHP. `index.php` renders the app; `assets/{css,js,img}`
  hold the static front-end files (including `img/logo.svg`).
- **`api/`** — PHP endpoints that proxy to the engine. Each mirrors an engine endpoint 1:1 and
  forwards JSON, so the browser never contacts the engine directly (no CORS, engine stays hidden).
- **`lib/`** — small PHP helpers, e.g. `EngineClient` (talks to the engine) and `Config` (reads ports
  from the environment).
- **`_legacy_reference/`** — an old PHP stub kept for reference only; it is not part of the shipped app.

## `runtimes/` — portable interpreters

Provisioned by the launchers on first run so the user installs nothing system-wide.

- **`php/`** — portable PHP, per OS (`php/win/`, `php/mac/`). Small enough to commit where possible.
- **`python/`** — portable Python + PyTorch (`python/win/`, `python/mac/`). These are large (GBs) and
  are **not committed** — they are auto-provisioned on first launch and are gitignored.

## `launchers/` — shared bootstrap logic

Common, reusable bootstrap code shared by the two root entry points (e.g. `common.sh`, `common.bat`).
Provisioning is idempotent and requires no system install from the user.

## Root entry points

- **`start.bat`** — Windows / NVIDIA CUDA launcher.
- **`start.command`** — macOS / Apple Silicon (MPS) launcher.

Both ensure runtimes exist, start the engine, start the PHP UI, and open the browser at
`http://127.0.0.1:8888`. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the runtime flow.
