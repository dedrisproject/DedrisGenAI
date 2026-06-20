# Running DedrisGenAI on Google Colab

DedrisGenAI can run on a free Google Colab GPU, giving you the full **PHP web UI** backed by a
CUDA GPU — no local install required.

**Open the notebook:**
[engine/dedrisgenai_colab.ipynb](../engine/dedrisgenai_colab.ipynb) ·
[Open in Colab](https://colab.research.google.com/github/dedrisproject/DedrisGenAI/blob/master/engine/dedrisgenai_colab.ipynb)

## One-click run

1. Click the **Open in Colab** badge above.
2. Set a GPU runtime: **Runtime → Change runtime type → Hardware accelerator: GPU**.
3. **Runtime → Run all.**
4. When the last cells finish, **click the printed link** to open the UI in a new tab.

That's it. The notebook clones the repo, installs everything, starts both services, and surfaces a
public URL.

## What the notebook does

1. Clones the repository into `/content/DedrisGenAI`.
2. Installs the **PHP CLI** (Colab does not ship PHP) and the **CUDA build of PyTorch** plus the
   engine's Python requirements.
3. Starts the **engine** (`engine/server.py`, CWD = `engine/`) on `127.0.0.1:7866` and waits for
   `/api/health`.
4. Starts the **PHP web UI** on `127.0.0.1:8888` (`php -S ... webui/public/router.php`).
5. Exposes the UI through Colab's port proxy and prints a clickable link. A cloudflared tunnel
   fallback is included.

The cells are idempotent: re-running them will not start a second engine or UI if one is already
healthy.

## Troubleshooting

### Make sure you are on a GPU runtime

Before running anything, set **Runtime → Change runtime type → Hardware accelerator: GPU**, then
**Runtime → Run all**. The dependency cell prints whether CUDA is visible:

```
torch 2.x.x | CUDA available: True
GPU: Tesla T4
```

If it prints `CUDA available: False`, you are on a CPU runtime — switch to GPU and re-run.
DedrisGenAI works on CPU only in theory; generation would be impractically slow.

### First run is slow (model download)

The **first** engine start downloads the default SDXL model (several GB) and primes caches before
`/api/health` reports ready. This commonly takes a few minutes; the start cell polls and prints
`...waiting for engine (downloading model on first run)` while it works. This only happens once per
session. Watch the live engine log with:

```python
!tail -n 50 /content/dedris_engine.log
```

If the engine process exits early, the cell prints the last log lines and stops — read them to see
what failed (usually a download timeout; just re-run the cell).

### Enhance / auto-mask features may be unavailable (rembg / cupy)

The **Enhance** tab and automatic mask generation depend on `rembg`, which pulls in
`pymatting → cupy`, plus the SAM / GroundingDINO models. Colab ships a preinstalled `cupy` that is
frequently **ABI-incompatible with NumPy**, so importing that chain can fail.

This is **non-blocking for text-to-image**: the engine imports those heavy modules lazily (only when
a mask is actually generated), so the engine starts and plain generation works regardless. If you
try the Enhance/auto-mask feature and it errors on Colab, that is the expected limitation — stick to
standard generation, or run DedrisGenAI locally where the runtime is provisioned cleanly.

### The Colab proxy link does not open

Some browsers, extensions, or corporate networks block Colab's `proxyPort` links. Use the
**cloudflared tunnel fallback** cell instead — it downloads `cloudflared` and opens a temporary
public `https://<random>.trycloudflare.com` URL to the UI. Treat that URL as public for the life of
the session.

### UI loads but generation fails / "engine unreachable"

The PHP UI proxies to the engine on port 7866. If the UI is up but calls fail, the engine probably
isn't healthy yet (still downloading the model) — wait for the engine start cell to finish, then
reload the UI. Check both logs:

```python
!tail -n 50 /content/dedris_engine.log
!tail -n 50 /content/dedris_ui.log
```

### Ports

Defaults are UI `8888` and engine `7866`. Override before the start cells by setting
`DEDRIS_UI_PORT` / `DEDRIS_ENGINE_PORT` in the environment (e.g. `os.environ['DEDRIS_UI_PORT']='9000'`).

### Session limits

Colab runtimes are temporary. When the session ends (idle timeout, closed tab, or the free-tier
limit), the runtime — and both services — stop, and downloaded models are discarded. Re-running the
notebook re-downloads them. Keep the tab open while you work.
