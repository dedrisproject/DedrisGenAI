# DedrisGenAI engine on Docker

You can run the DedrisGenAI generation engine in a container. The image is based on NVIDIA CUDA 12.4
and PyTorch 2.1; see [`engine/docker/Dockerfile`](../engine/docker/Dockerfile) and
[`engine/requirements_docker.txt`](../engine/requirements_docker.txt) for details.

> **Note:** Docker runs the **Python engine** only (the headless generation backend). The PHP web UI
> and the portable launchers (`start.bat` / `start.command`) are the normal way to use DedrisGenAI on
> a desktop. The container exposes the engine's HTTP service directly. The Docker setup is inherited
> from the upstream Fooocus project (see the project README's Credits section).

## Requirements

- A computer with specs good enough to run DedrisGenAI, and proprietary NVIDIA drivers
- Docker, Docker Compose, or Podman

## Quick start

**More information in the [notes](#notes).**

All Docker commands below are run from the `engine/` directory (or from `engine/docker/` where the
compose file lives).

### Running with Docker Compose

1. Clone this repository.
2. `cd engine/docker`
3. Run the container with `docker compose up`.

### Running with Docker

```sh
docker run -p 7865:7865 -v dedrisgenai-data:/content/data -it \
--gpus all \
-e CMDARGS=--listen \
-e DATADIR=/content/data \
-e config_path=/content/data/config.txt \
-e config_example_path=/content/data/config_modification_tutorial.txt \
-e path_checkpoints=/content/data/models/checkpoints/ \
-e path_loras=/content/data/models/loras/ \
-e path_embeddings=/content/data/models/embeddings/ \
-e path_vae_approx=/content/data/models/vae_approx/ \
-e path_upscale_models=/content/data/models/upscale_models/ \
-e path_inpaint=/content/data/models/inpaint/ \
-e path_controlnet=/content/data/models/controlnet/ \
-e path_clip_vision=/content/data/models/clip_vision/ \
-e path_dedris_expansion=/content/data/models/prompt_expansion/dedris_expansion/ \
-e path_outputs=/content/app/outputs/ \
dedrisgenai
```

### Running with Podman

```sh
podman run -p 7865:7865 -v dedrisgenai-data:/content/data -it \
--security-opt=no-new-privileges --cap-drop=ALL --security-opt label=type:nvidia_container_t --device=nvidia.com/gpu=all \
-e CMDARGS=--listen \
-e DATADIR=/content/data \
-e config_path=/content/data/config.txt \
-e config_example_path=/content/data/config_modification_tutorial.txt \
-e path_checkpoints=/content/data/models/checkpoints/ \
-e path_loras=/content/data/models/loras/ \
-e path_embeddings=/content/data/models/embeddings/ \
-e path_vae_approx=/content/data/models/vae_approx/ \
-e path_upscale_models=/content/data/models/upscale_models/ \
-e path_inpaint=/content/data/models/inpaint/ \
-e path_controlnet=/content/data/models/controlnet/ \
-e path_clip_vision=/content/data/models/clip_vision/ \
-e path_dedris_expansion=/content/data/models/prompt_expansion/dedris_expansion/ \
-e path_outputs=/content/app/outputs/ \
dedrisgenai
```

When you see the message `Use the app with http://0.0.0.0:7865/` in the console, you can access the
URL in your browser.

Your models and outputs are stored in the `dedrisgenai-data` volume, which, depending on OS, is
stored in `/var/lib/docker/volumes/` (or `~/.local/share/containers/storage/volumes/` when using
`podman`).

## Building the container locally

Clone the repository first, then open a terminal in `engine/docker/`.

Build with `docker`:
```sh
docker build -f Dockerfile ../.. -t dedrisgenai
```

Build with `podman`:
```sh
podman build -f Dockerfile ../.. -t dedrisgenai
```

## Details

### Update the container manually (`docker compose`)

When you are using `docker compose up` continuously, the container is not updated to the latest
version automatically. Run `git pull` before executing `docker compose build --no-cache` to build an
image with the latest engine version. You can then start it with `docker compose up`.

### Import models, outputs

If you want to import files from the models or outputs folder, add the following bind mounts in
[`engine/docker/docker-compose.yml`](../engine/docker/docker-compose.yml) or your preferred method of
running the container:
```
#- ./models:/import/models   # Once you import files, you don't need to mount again.
#- ./outputs:/import/outputs  # Once you import files, you don't need to mount again.
```
After running the container, your files will be copied into `/content/data/models` and
`/content/data/outputs`. Since `/content/data` is a persistent volume folder, your files will be
persisted even when you re-run the container without the above mounts.

### Paths inside the container

|Path|Details|
|-|-|
|/content/app|The application stored folder|
|/content/app/models.org|Original 'models' folder.<br> Files are copied to '/content/app/models' which is symlinked to '/content/data/models' every time the container boots. (Existing files will not be overwritten.) |
|/content/data|Persistent volume mount point|
|/content/data/models|The folder is symlinked to '/content/app/models'|
|/content/data/outputs|The folder is symlinked to '/content/app/outputs'|

### Environments

You can change `config.txt` parameters by using environment variables.
**The priority of using the environments is higher than the values defined in `config.txt`, and they will be saved to `config_modification_tutorial.txt`.**

Docker-specific environments are below. They are used by `entrypoint.sh`.
|Environment|Details|
|-|-|
|DATADIR|'/content/data' location.|
|CMDARGS|Arguments for `entry_with_update.py`, which is called by `entrypoint.sh`|
|config_path|'config.txt' location|
|config_example_path|'config_modification_tutorial.txt' location|
|HF_MIRROR| huggingface mirror site domain|

You can also use the same JSON key names and values explained in `config_modification_tutorial.txt`
as the environments. See examples in
[`engine/docker/docker-compose.yml`](../engine/docker/docker-compose.yml).

## Notes

- Please keep `path_outputs` under `/content/app`. Otherwise, you may get an error when you open the history log.
- Docker on Mac/Windows still has issues in the form of slow volume access when you use "bind mount" volumes. Please refer to [this article](https://docs.docker.com/storage/volumes/#use-a-volume-with-docker-compose) for not using "bind mount".
- The MPS backend (Metal Performance Shaders, Apple Silicon M1/M2/etc.) is not yet supported in Docker, see https://github.com/pytorch/pytorch/issues/81224. On Apple Silicon, use the `start.command` launcher instead.
- You can also use `docker compose up -d` to start the container detached and connect to the logs with `docker compose logs -f`. This way you can also close the terminal and keep the container running.
