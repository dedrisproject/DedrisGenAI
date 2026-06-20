#!/bin/bash
# DedrisGenAI container entrypoint: persist models/outputs to a data volume, start
# the Python engine (internal :7866), then serve the PHP web UI (exposed :8888).
set -e

APP=/content/app
ENGINE=$APP/engine
DATADIR=${DATADIR:-/content/data}
ENGINE_PORT=${DEDRIS_ENGINE_PORT:-7866}
UI_PORT=${DEDRIS_UI_PORT:-8888}
HOST=${DEDRIS_HOST:-0.0.0.0}

# Symlink a dir under the engine to the persistent data volume.
mklink () {
	mkdir -p "$DATADIR/$1"
	rm -rf "$ENGINE/$1"
	ln -s "$DATADIR/$1" "$ENGINE/$1"
}

# models: persist in the volume; seed with the repo's shipped support files
# (prompt-expansion config/tokenizer, "put_*_here" markers, etc.). Weights are
# downloaded at runtime into the volume on first use.
mklink models
if [ -d "$ENGINE/models.org" ]; then
	(cd "$ENGINE/models.org" && cp -Rpn . "$ENGINE/models/") 2>/dev/null || true
fi

# outputs: persist generated images in the volume.
mklink outputs

# Start the engine (binds 127.0.0.1:7866 internally) in the background.
cd "$ENGINE"
DEDRIS_ENGINE_PORT="$ENGINE_PORT" python server.py &
ENGINE_PID=$!

# Wait until the engine answers /api/health (does NOT trigger the heavy model
# download — that happens lazily on the first generate/options call).
echo "[DedrisGenAI] starting engine on 127.0.0.1:${ENGINE_PORT} ..."
for _ in $(seq 1 600); do
	if curl -fsS "http://127.0.0.1:${ENGINE_PORT}/api/health" >/dev/null 2>&1; then
		echo "[DedrisGenAI] engine ready."
		break
	fi
	if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
		echo "[DedrisGenAI] engine process exited during startup." >&2
		exit 1
	fi
	sleep 2
done

# Serve the PHP web UI in the foreground (this is the exposed service on :8888).
cd "$APP"
echo "[DedrisGenAI] serving PHP UI on ${HOST}:${UI_PORT}"
exec php -S "${HOST}:${UI_PORT}" -t webui/public webui/public/router.php
