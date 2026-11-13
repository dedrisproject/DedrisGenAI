# Architecture

DedrisGenAI is two cooperating local services: a **PHP web UI** and a **Python generation engine**.
The browser only ever talks to the PHP UI; the PHP UI proxies to the engine over localhost. This
keeps the engine hidden, avoids CORS, and gives the UI a single, stable origin.

## Request flow

```
┌─────────┐   HTTP    ┌──────────────┐   HTTP    ┌─────────────────┐
│ Browser │ ───────▶  │   PHP UI     │ ───────▶  │  Python engine  │
│         │           │ 127.0.0.1:   │           │  127.0.0.1:     │
│         │  ◀─────── │    8888       │  ◀─────── │     7866        │
└─────────┘   JSON    │ (public/ +   │   JSON    │  (server.py)    │
                      │  api/ proxy) │           │   → worker      │
                      └──────────────┘           └────────┬────────┘
                                                          │
                                                   AsyncTask / worker
                                                          │
                                                      generated
                                                       images
```

Step by step:

1. **Browser → PHP UI.** The user loads `http://127.0.0.1:8888` (served from `webui/public/index.php`)
   and the front-end JS calls the PHP API endpoints under `webui/api/`.
2. **PHP proxy → engine.** Each PHP endpoint reads the request JSON and forwards it to
   `http://127.0.0.1:<DEDRIS_ENGINE_PORT>/api/...`, then returns the engine's JSON verbatim. The PHP
   endpoints mirror the engine endpoints 1:1.
3. **Engine → worker.** `engine/server.py` maps the request onto the same `AsyncTask` / `worker` flow
   used by the legacy UI, so generation results are identical. Models are loaded once at engine
   startup; each `POST /api/generate` enqueues a task and returns a `task_id`.
4. **Polling.** The UI polls `GET /api/progress?task_id=...` for live state, progress, a preview, and —
   when done — the list of output image URLs.

## Ports and configuration

| Service     | Default address     | Env override          |
|-------------|---------------------|-----------------------|
| PHP UI      | `127.0.0.1:8888`    | `DEDRIS_UI_PORT`      |
| Python engine | `127.0.0.1:7866`  | `DEDRIS_ENGINE_PORT`  |
| Engine supervisor (control API) | `127.0.0.1:7867` | `DEDRIS_SUPERVISOR_PORT` |

The PHP UI needs to know the engine port too (it proxies to it), so it reads both
`DEDRIS_UI_PORT` and `DEDRIS_ENGINE_PORT` from the environment. A small `webui/lib/Config.php` exposes
these with the defaults above.

## Engine supervisor (`engine/supervisor.py`)

The launchers, Docker and the Colab notebook do not run `server.py` directly: they run
`supervisor.py`, which starts `server.py` as a child process and keeps it alive.

* **Crash restart.** If the engine exits on its own (e.g. the OS kills it for running out of RAM,
  exit code `-9`, which leaves no traceback in the log) it is relaunched after a short backoff.
  After 3 rapid crashes in a row auto-restart pauses (state `failed`); a manual restart is still
  possible.
* **Hang watchdog.** Once the engine has been healthy, if `/api/health` then fails for
  `DEDRIS_WATCHDOG_SECS` seconds (default `180`, `0` disables) the process is killed and relaunched.
* **Control API** on loopback only: `GET /status` (`state`, `pid`, `restarts`, `last_exit_reason`,
  `oom_suspected`, ...) and `POST /restart`.

The PHP UI reaches it through `GET/POST /api/engine` (`webui/api/engine.php`). When the UI loses
contact with the engine it asks for the supervisor status to explain what happened (crash, out of
memory, hung) and offers a **Restart engine** button. A generation running when the engine dies is
lost; the UI says so and the user can press Generate again. Set `DEDRIS_ALLOW_ENGINE_RESTART=0` to
disable the button (the automatic restarts still happen). If the engine was started without the
supervisor (`python server.py` by hand) the UI still works, just without the restart button.

## Engine HTTP API (`engine/server.py`)

JSON over HTTP. All endpoints are under `/api` (plus a static `/outputs` route for images).

| Method & path | Purpose |
|---------------|---------|
| `GET /api/health` | Liveness/version: `{ "status":"ok", "version":"1.0.0", "device":"cuda\|mps\|cpu" }` |
| `GET /api/options` | Everything the UI needs to render the controls (see below). |
| `GET /api/preset?name=Standard\|Anime\|Realistic` | The preset's default settings. |
| `POST /api/generate` | Start a generation. Body = generation params. Returns `{ "task_id":"<id>" }`. |
| `GET /api/progress?task_id=ID` | Poll a task's state, progress, preview, and final images. |
| `POST /api/stop` | Cancel a task. Body `{ "task_id":"ID" }`. |
| `GET /outputs/<path>` | Serve a generated image file. |

### `GET /api/options`

Returns the lists the UI populates its controls from:

```json
{
  "presets": ["Standard","Anime","Realistic"],
  "performances": ["Quality","Speed","Extreme Speed","Lightning","Hyper-SD"],
  "aspect_ratios": ["704*1408", "..."],
  "samplers": ["euler", "..."],
  "schedulers": ["normal","karras", "..."],
  "output_formats": ["png","jpeg","webp"],
  "styles": [{"name":"DedrisGenAI V2","preview":"<url|null>"}, "..."],
  "models": {"checkpoints":["..."], "loras":["None","..."], "vaes":["Default (model)","..."]}
}
```

### `GET /api/preset`

Returns a preset's defaults: model, styles, CFG, sharpness, sampler, scheduler, performance, aspect
ratio, negative prompt, and LoRAs. The three preset names map to files in `engine/presets/`:
`Standard → default.json`, `Anime → anime.json`, `Realistic → realistic.json`.

### `POST /api/generate`

Body is a superset of generation params; missing fields fall back to the active preset:

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
  "loras": [[true,"sd_xl_offset_example-lora_1.0.safetensors",0.1], [true,"None",1.0]],
  "sampler": "dpmpp_2m_sde_gpu", "scheduler": "karras",
  "steps_override": -1, "vae": "Default (model)", "clip_skip": 1
}
```

### `GET /api/progress`

```json
{
  "state": "pending|running|done|error|stopped",
  "progress": 0,
  "preview": "<dataURL|null>",
  "message": "...",
  "images": ["/outputs/....png"]
}
```

`images` is populated when `state` is `done`.

## PHP proxy endpoints (`webui/api/`)

The PHP layer mirrors the engine 1:1:

```
health.php   options.php   preset.php   generate.php   progress.php   stop.php   (+ image passthrough)
```

`engine.php` is the exception: it talks to the engine *supervisor* (see above), not the engine.

Each reads JSON from the incoming request, forwards it to
`http://127.0.0.1:<DEDRIS_ENGINE_PORT>/api/...`, and returns the engine's JSON unchanged. Because the
browser only talks to PHP, there are no CORS concerns and the engine is never exposed directly.

## Where things live

| Thing | Location |
|-------|----------|
| **Presets** | `engine/presets/` — `default.json` (Standard), `anime.json`, `realistic.json` |
| **Styles** | `engine/sdxl_styles/` (e.g. the DedrisGenAI style family, including "DedrisGenAI V2") |
| **Models** | `engine/models/` (`checkpoints/`, `loras/`, `vae/`, `inpaint/`, `controlnet/`, ...) |
| **Generated images** | the engine's outputs directory, served at `GET /outputs/<path>` |
| **Front-end assets** | `webui/public/assets/{css,js,img}` |
| **Port config** | environment: `DEDRIS_UI_PORT`, `DEDRIS_ENGINE_PORT` (read by `webui/lib/Config.php`) |

## Startup (launchers & runtimes)

Both root entry points — `run.bat` (Windows/CUDA) and `start.command` (macOS/MPS) — do the same
four things, with platform-specific runtime provisioning:

1. **Ensure portable runtimes exist.** Provision portable PHP (`runtimes/php/<os>/`) and portable
   Python + PyTorch (`runtimes/python/<os>/`) if missing. Windows installs the CUDA torch build;
   macOS uses CPU/MPS wheels and sets `PYTORCH_ENABLE_MPS_FALLBACK=1`. Provisioning is idempotent.
2. **Start the engine** with the portable Python running `engine/supervisor.py` (working directory =
   `engine/`), which launches `engine/server.py` on `DEDRIS_ENGINE_PORT` and restarts it if it
   crashes or hangs.
3. **Start the PHP UI** with portable PHP serving `webui/public/` on `DEDRIS_UI_PORT`.
4. **Open the browser** at `http://127.0.0.1:8888`.

Shared bootstrap logic lives in `launchers/`. The Python runtime and models (several GB) are not
committed — they are downloaded on first launch.

For debugging, the engine can also be run the legacy way: `python launch.py` from inside `engine/`.
