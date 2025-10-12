# PHP Prompt API Daemon

This folder contains a lightweight PHP daemon that exposes a REST-style API
for executing prompts.  The daemon can be started with a regular PHP CLI
process and is intended to run continuously in the background.

## Files

- `prompt_api_daemon.php`: the entry point that starts the TCP server and
  handles HTTP requests.
- `PromptExecutor.php`: small helper that performs the actual prompt
  execution.  Replace the logic inside `execute()` with your application
  specific code.
- `prompt_client.html`: semplice interfaccia web che invia richieste AJAX
  all'endpoint `/execute` del demone.

## Running the daemon

```bash
php php/prompt_api_daemon.php
```

Environment variables:

- `PROMPT_API_HOST` (default `127.0.0.1`): interface to bind.
- `PROMPT_API_PORT` (default `8080`): port the daemon listens on.

### Windows quick start (port 9001)

For a ready-to-run configuration that binds the daemon to port `9001`, use the
included batch file:

```bat
php\start_prompt_daemon_9001.bat
```

The script sets the appropriate environment variables and launches the daemon
from the repository root or any other directory.

## API

### `POST /execute`

Send a JSON payload containing a `prompt` field. The daemon passes the prompt
to the `PromptExecutor` and returns the structured result.

```bash
curl -X POST "http://127.0.0.1:9001/execute" \
     -H "Content-Type: application/json" \
     -d '{"prompt": "Hello daemon"}'
```

Example response:

```json
{
    "status": "success",
    "result": {
        "prompt": "Hello daemon",
        "response": "Prompt processed at 2024-05-01T12:00:00+00:00",
        "timestamp": "2024-05-01T12:00:00+00:00"
    }
}
```

### `GET /health`

Simple health check endpoint returning `{ "status": "ok" }` to indicate that
the daemon is running.

## Postman collection

Import `php/prompt_api_daemon.postman_collection.json` into Postman for
pre-configured requests targeting the daemon on port `9001`. The collection
includes:

- **Health Check** – verifies that the service is running.
- **Execute Prompt** – sends a sample prompt payload and displays the response.

## Interfaccia web con AJAX

Per testare rapidamente l'API dal browser è disponibile la pagina
`prompt_client.html`. I passaggi consigliati sono:

1. Avvia il demone (es. con `php php/prompt_api_daemon.php` oppure tramite lo
   script batch su Windows) assicurandoti che sia in ascolto su `127.0.0.1:9001`.
2. Avvia un semplice web server per servire i file statici, ad esempio:

   ```bash
   php -S 127.0.0.1:8000 -t php
   ```

3. Apri il browser su `http://127.0.0.1:8000/prompt_client.html`, inserisci il
   prompt nel form e premi "Invia prompt". La risposta JSON del demone verrà
   mostrata all'interno della pagina.

Il demone restituisce intestazioni CORS permissive (`Access-Control-Allow-*`)
in modo da accettare chiamate AJAX anche da domini o porte differenti durante
lo sviluppo.
