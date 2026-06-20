<div align="center">
  <img src="webui/public/assets/img/logo.svg" alt="DedrisGenAI" width="160">

  <h1>DedrisGenAI</h1>

  <p><strong>An offline, high-quality image generator with a clean web UI.</strong></p>
  <p>Type a prompt, pick a preset, generate. No accounts, no cloud, no fuss.</p>
</div>

---

DedrisGenAI is a desktop image generator that runs entirely on your own machine. It pairs a
lightweight **PHP web UI** with a powerful **Python + PyTorch generation engine**, and ships with
**portable launchers** so there is nothing to install system-wide — double-click one file and your
browser opens to the app.

The engine is built on the proven Stable Diffusion XL pipeline from the **Fooocus** project (see
[Credits](#credits)), re-architected around a local HTTP API and a modern PHP front end.

## Features

- **Three curated presets** — Standard, Anime, and Realistic — tuned for great results out of the box.
- **Prompt-first workflow** — high-quality text-to-image without heavy prompt engineering or knob-twiddling.
- **Built-in prompt expansion** — the "DedrisGenAI V2" style enriches short prompts automatically.
- **Full control when you want it** — base/refiner models, up to 5 LoRAs, CFG/guidance, sharpness,
  sampler, scheduler, steps, VAE, CLIP skip, aspect ratio, seed, and output format (PNG/JPEG/WebP).
- **Image-input tools** — Upscale/Vary, Image Prompt, Inpaint/Outpaint, Describe, Enhance, and Metadata.
- **Live results** — gallery output with a real-time progress bar and preview.
- **Runs offline** — generation happens locally; the browser only ever talks to a local PHP server.
- **Cross-platform launchers** — Windows (NVIDIA CUDA) and macOS (Apple Silicon / MPS).

## The 3 presets

| Preset      | Best for                                    | Selector label |
|-------------|---------------------------------------------|----------------|
| **Standard**  | General-purpose, versatile image generation | `Standard`     |
| **Anime**     | Stylized, illustrative, anime-style art     | `Anime`        |
| **Realistic** | Photographic, lifelike results              | `Realistic`    |

Each preset bundles its own default model, styles, sampler, scheduler, CFG, sharpness, and aspect
ratio. You can switch presets at any time in the UI, and override any individual setting per
generation. Presets live in `engine/presets/` (`default.json` = Standard, `anime.json`, `realistic.json`).

## Quick start

You do **not** need to install Python, PyTorch, or PHP yourself. The launcher provisions a portable
runtime on first run (this first run downloads several GB and can take a while), then starts both
services and opens your browser at `http://127.0.0.1:8888`.

### Windows (NVIDIA CUDA)

1. Make sure you have a recent NVIDIA GPU and up-to-date drivers.
2. Double-click **`start.bat`** in the project root.
   - Or from a terminal: `start.bat`
3. Wait for the first-run provisioning to finish. Your browser opens to the app automatically.

The Windows launcher installs the CUDA build of PyTorch and runs the engine on your GPU.

### macOS (Apple Silicon / MPS)

1. Make sure you are on an Apple Silicon Mac (M1/M2/M3 or newer).
2. Double-click **`start.command`** in the project root.
   - Or from a terminal: `./start.command`
   - If macOS blocks it the first time, run `chmod +x start.command` and try again, or right-click →
     **Open** to approve it in Gatekeeper.
3. Wait for first-run provisioning. Your browser opens to the app automatically.

The macOS launcher uses PyTorch with Metal (MPS) acceleration and sets
`PYTORCH_ENABLE_MPS_FALLBACK=1` for unsupported operations.

### Run on Google Colab

No local GPU? Run DedrisGenAI on a free Google Colab GPU:

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/dedrisproject/DedrisGenAI/blob/master/engine/dedrisgenai_colab.ipynb)

The notebook installs PHP and the CUDA build of PyTorch, starts the engine and the PHP web UI, and
exposes the **same PHP UI** through Colab's built-in port proxy — so you get the full GPU-backed
DedrisGenAI experience in your browser, no install required. Set **Runtime → Change runtime type →
GPU** first, then run all cells and click the printed link. A cloudflared tunnel fallback is included
if the proxy link is blocked. See [`docs/COLAB.md`](docs/COLAB.md) for troubleshooting.

> **Ports:** the UI runs on `127.0.0.1:8888` and the engine on `127.0.0.1:7866`. Override with the
> `DEDRIS_UI_PORT` and `DEDRIS_ENGINE_PORT` environment variables.

## How it works

DedrisGenAI is two cooperating local services:

1. **PHP web UI (`webui/`)** — serves the interface and exposes a set of PHP API endpoints. Your
   browser only ever talks to this PHP server (no CORS, the engine stays hidden).
2. **Python engine (`engine/server.py`)** — an HTTP service wrapping the SDXL generation pipeline.
   It loads models once at startup and runs generation jobs.

The request flow is:

```
Browser  →  PHP UI (8888)  →  PHP proxy /api/*  →  Python engine (7866)  →  worker → images
```

The PHP `api/*` endpoints mirror the engine's `/api/*` endpoints 1:1 and simply forward JSON. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full request flow and API reference.

For debugging, the engine can still be run the legacy way with `python launch.py` from inside
`engine/`.

## Folder structure

```
DedrisGenAI/
├─ engine/          # Python generation engine (SDXL backend); runs with CWD=engine/
│  ├─ modules/      # backend logic (worker, config, flags, styles, ...)
│  ├─ ldm_patched/  # diffusion backend
│  ├─ extras/       # BLIP, GroundingDINO, prompt expansion, etc.
│  ├─ presets/      # default.json (Standard), anime.json, realistic.json
│  ├─ sdxl_styles/  # style definitions
│  ├─ models/       # checkpoints, loras, vae, ... (downloaded on demand)
│  ├─ server.py     # HTTP API the PHP UI calls
│  └─ launch.py     # legacy entry point (debugging)
├─ webui/           # PHP web UI (replaces the old Gradio UI)
│  ├─ public/       # document root: index.php + assets/
│  ├─ api/          # PHP endpoints that proxy to the engine
│  └─ lib/          # PHP helpers (EngineClient, Config)
├─ runtimes/        # portable PHP + Python runtimes (provisioned on first run)
├─ launchers/       # shared bootstrap logic
├─ docs/            # documentation
├─ start.bat        # entry point — Windows / NVIDIA CUDA
├─ start.command    # entry point — macOS / MPS
└─ README.md        # this file
```

A fuller explanation is in [`docs/STRUCTURE.md`](docs/STRUCTURE.md).

## Requirements

The launchers provision a portable runtime, so you don't install anything globally. You do need a
capable machine:

| Platform | GPU / Acceleration  | Notes |
|----------|---------------------|-------|
| Windows  | NVIDIA (CUDA)       | 4GB+ VRAM, recent drivers. Use `start.bat`. |
| macOS    | Apple Silicon (MPS) | M1/M2/M3+. Use `start.command`. Slower than a discrete NVIDIA GPU. |

Plenty of free disk space is recommended — the portable Python runtime, PyTorch, and the default
models together take several GB. See [`docs/troubleshoot.md`](docs/troubleshoot.md) for common
issues (system swap, model corruption, out-of-memory, etc.).

## Documentation

- [`docs/STRUCTURE.md`](docs/STRUCTURE.md) — folder layout explained.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — request flow, API endpoints, where things live.
- [`docs/COLAB.md`](docs/COLAB.md) — running on Google Colab (GPU runtime, tunnel fallback, model download).
- [`docs/development.md`](docs/development.md) — running tests and developing.
- [`docs/docker.md`](docs/docker.md) — running the engine in Docker.
- [`docs/troubleshoot.md`](docs/troubleshoot.md) — common problems and fixes.
- [`docs/update_log.md`](docs/update_log.md) — engine change history.

## Credits

DedrisGenAI's generation engine is based on the open-source **[Fooocus](https://github.com/lllyasviel/Fooocus)**
project by lllyasviel and contributors, which is itself built on a mixture of
[Stable Diffusion WebUI](https://github.com/AUTOMATIC1111/stable-diffusion-webui) and
[ComfyUI](https://github.com/comfyanonymous/ComfyUI). We gratefully acknowledge that work and its
contributors — DedrisGenAI would not exist without it. The original Fooocus license is retained in
[`LICENSE`](LICENSE), and upstream attribution is preserved in the documentation where relevant.

Additional thanks to the SDXL style contributors [twri](https://github.com/twri),
[3Diva](https://github.com/3Diva), and [Marc K3nt3L](https://github.com/K3nt3L), and to
[daswer123](https://github.com/daswer123) for the Canvas Zoom feature.

DedrisGenAI is the product name. "Fooocus" appears here and in the docs **only** as upstream
attribution, never as the name of this product.
