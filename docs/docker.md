# DedrisGenAI on Docker

Run the **full DedrisGenAI app in a container** — the Python+PyTorch engine **and** the PHP web UI.
The image is based on NVIDIA CUDA 12.4; see [`docker/Dockerfile`](../docker/Dockerfile),
[`docker/entrypoint.sh`](../docker/entrypoint.sh) and
[`engine/requirements_versions.txt`](../engine/requirements_versions.txt).

> The container runs the engine internally on `127.0.0.1:7866` and serves the **PHP web UI on port
> `8888`** (the only exposed service) — the same UI you get from the desktop launchers, **not** the
> legacy Gradio UI. Open `http://localhost:8888` once it's up.

## Requirements

- An NVIDIA GPU with proprietary drivers + the NVIDIA Container Toolkit
- Docker (with Compose) or Podman

## Quick start (Docker Compose)

From the repository root:

```sh
docker compose -f docker/docker-compose.yml up --build
```

Then open **http://localhost:8888**. The first generation downloads the selected model into the
persistent volume (a few GB; one time per model).

## Quick start (Docker)

Build (context is the repo root so both `engine/` and `webui/` are included):

```sh
docker build -f docker/Dockerfile -t dedrisgenai .
```

Run:

```sh
docker run --gpus all -p 8888:8888 -v dedrisgenai-data:/content/data -it dedrisgenai
```

## Quick start (Podman)

```sh
podman build -f docker/Dockerfile -t dedrisgenai .
podman run --device=nvidia.com/gpu=all -p 8888:8888 -v dedrisgenai-data:/content/data -it dedrisgenai
```

## Persistence

Models and generated images live in the **`dedrisgenai-data`** volume (mounted at `/content/data`).
`entrypoint.sh` symlinks `engine/models` → `/content/data/models` and `engine/outputs` →
`/content/data/outputs`, seeds the models folder with the small support files shipped in the image
(prompt-expansion config/tokenizer), and lets the engine download weights into the volume on first
use. The volume persists across container restarts.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DEDRIS_UI_PORT` | `8888` | Port the PHP UI listens on (exposed). |
| `DEDRIS_ENGINE_PORT` | `7866` | Internal engine port (not exposed). |
| `DEDRIS_HOST` | `0.0.0.0` | Bind address for the PHP UI. |
| `DATADIR` | `/content/data` | Persistent volume location (models + outputs). |

## Paths inside the container

| Path | Details |
|---|---|
| `/content/app` | The app (`engine/` + `webui/`). |
| `/content/app/engine/models.org` | The shipped models support files; copied into the volume-backed `engine/models` on boot (existing files are not overwritten). |
| `/content/data/models` | Persistent models (symlinked to `engine/models`). |
| `/content/data/outputs` | Persistent outputs (symlinked to `engine/outputs`). |

## Updating

```sh
git pull
docker compose -f docker/docker-compose.yml build --no-cache
docker compose -f docker/docker-compose.yml up
```

## Notes

- The model weights and the provisioned `runtimes/` are excluded from the build context via
  `.dockerignore`, so the image stays lean and weights are fetched at runtime.
- The MPS backend (Apple Silicon) is not supported in Docker — on a Mac use the `start.command`
  launcher instead.
- `docker compose -f docker/docker-compose.yml up -d` runs detached; follow logs with
  `docker compose -f docker/docker-compose.yml logs -f`.
