# runtimes/ — portable runtimes (auto-provisioned)

This folder holds the **self-contained PHP and Python runtimes** that DedrisGenAI
needs in order to run. **Nothing here needs to be installed manually.** The first
time you launch the app, the launcher downloads and unpacks everything into this
folder. Subsequent launches detect what is already present and start instantly
(idempotent fast path). Nothing is installed system-wide — it all stays inside this
repo and can be deleted by simply removing these directories.

Launch the app from the repo root:

- **Windows (NVIDIA / CUDA):** double-click `start.bat`
- **macOS (Apple Silicon / MPS) or Linux:** double-click `start.command`
  (or run `./start.command` from a terminal)

## What gets provisioned, and where

```
runtimes/
├─ php/
│  ├─ win/php.exe        # Windows: portable PHP CLI (official NTS x64 build)
│  ├─ win/php.ini        # auto-generated minimal config (curl, mbstring, openssl, fileinfo)
│  └─ mac/php            # macOS/Linux: static, dependency-free PHP CLI binary
├─ python/
│  ├─ win/python.exe     # Windows: embeddable Python + pip + torch (CUDA cu121) + engine deps
│  └─ mac/bin/python3    # macOS/Linux: Python venv + torch (CPU/MPS wheels) + engine deps
├─ cache/                # downloaded zips/tarballs (kept so re-provisioning is offline-safe)
└─ README.md             # this file
```

### PHP

| Platform | What | Source |
|---|---|---|
| Windows | `php-8.3.31-nts-Win32-vs16-x64.zip` (non-thread-safe x64), unzipped to `php/win/` | `https://downloads.php.net/~windows/releases/` (SHA256-verified best-effort) |
| macOS / Linux | `php-8.3.31-cli-macos-<arch>.tar.gz` (fully static, no dependencies) | `https://dl.static-php.dev/static-php-cli/bulk/` (the [static-php-cli](https://static-php.dev) project) |

The PHP version is pinned but overridable via `DEDRIS_PHP_VERSION`.

> **macOS caveat:** the official PHP project does **not** publish prebuilt macOS
> binaries, so we use the community **static-php-cli** builds (single, dependency-free
> binary — ideal for a portable runtime). If that download is unavailable and you
> already have PHP on your `PATH` (e.g. from Homebrew: `brew install php`), the
> launcher falls back to it and tells you so. The static binary is downloaded for
> Apple Silicon (`aarch64`) and Intel (`x86_64`) automatically based on your CPU.

### Python + PyTorch

| Platform | What | Torch flavor |
|---|---|---|
| Windows | Embeddable Python `3.11.9` (amd64) + pip bootstrapped via `get-pip.py` | `torch torchvision` from **CUDA cu121** index (`https://download.pytorch.org/whl/cu121`) |
| macOS / Linux | `python -m venv` built from your system Python ≥ 3.10 | `torch torchvision` from default PyPI wheels (**CPU/MPS** — there is no CUDA on Apple Silicon) |

After torch is installed, the launcher installs `engine/requirements_versions.txt`.
On macOS the launcher also sets `PYTORCH_ENABLE_MPS_FALLBACK=1` so any op that MPS
doesn't yet support transparently falls back to CPU instead of crashing.

The Python version is pinned (Windows) / auto-detected (macOS) and overridable via
`DEDRIS_PY_VERSION` where applicable.

> **Note:** torch + its dependencies are several GB. They are downloaded on first
> launch and are **never committed** to the repo — `runtimes/python/` is gitignored.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DEDRIS_ENGINE_PORT` | `7866` | Port the Python engine service listens on |
| `DEDRIS_UI_PORT` | `8888` | Port the PHP UI server listens on |
| `DEDRIS_HOST` | `127.0.0.1` | Bind/connect host |
| `DEDRIS_PHP_VERSION` | `8.3.31` | Portable PHP version to fetch |
| `DEDRIS_PY_VERSION` | `3.11.9` | Portable Python version to fetch (Windows) |

## Reset / re-provision

To force a clean re-provision, delete the relevant directory and relaunch:

```
runtimes/php/win    runtimes/php/mac
runtimes/python/win runtimes/python/mac
runtimes/cache      # delete to force fresh downloads
```

Removing the whole `runtimes/` (except this README and the `.gitkeep` files) is safe —
it will be rebuilt on the next launch.
