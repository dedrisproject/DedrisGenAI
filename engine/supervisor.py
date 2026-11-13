"""DedrisGenAI engine supervisor.

Runs ``server.py`` as a child process and keeps it alive:

* **Crash restart** - if the engine process exits on its own (e.g. the OS kills it
  for running out of RAM, which on Colab happens with no traceback), it is started
  again after a short backoff.
* **Hang watchdog** - once the engine has answered ``/api/health`` at least once,
  if it then stops answering for ``DEDRIS_WATCHDOG_SECS`` seconds (default 180,
  ``0`` disables) while the process is still alive, it is killed and restarted.
* **Control API** - a tiny HTTP server on ``127.0.0.1:DEDRIS_SUPERVISOR_PORT``
  (default 7867) that the PHP UI proxies to, so the browser can see why the engine
  is down and ask for a restart:

      GET  /status   -> {"supervised": true, "state": ..., "pid": ..., ...}
      POST /restart  -> 202 {"ok": true}

  ``state`` is one of: ``starting`` (process up, not healthy yet), ``running``
  (healthy), ``unresponsive`` (alive but health failing), ``restarting``,
  ``backoff`` (crashed, restarting shortly), ``failed`` (crashed repeatedly -
  auto-restart paused, a manual restart is still possible), ``stopped``.

The control port is bound to loopback only; the browser never reaches it
directly. Run it exactly like the engine: ``python supervisor.py`` with the
working directory set to ``engine/`` (it forwards stdout/stderr, so the engine
log is unchanged).
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
ENGINE_PORT = int(os.environ.get("DEDRIS_ENGINE_PORT", "7866"))
SUPERVISOR_PORT = int(os.environ.get("DEDRIS_SUPERVISOR_PORT", "7867"))
WATCHDOG_SECS = float(os.environ.get("DEDRIS_WATCHDOG_SECS", "180"))
HEALTH_EVERY = 5.0           # seconds between health probes
TERM_GRACE = 15.0            # seconds to wait after SIGTERM before SIGKILL
# Auto-restart is paused (state "failed") after this many consecutive crashes
# that happen before the engine ever became healthy, or shortly after it did.
MAX_RAPID_CRASHES = 3
RAPID_WINDOW = 90.0          # a crash within this many seconds of becoming healthy counts as "rapid"


def log(msg: str) -> None:
    print(f"[supervisor] {msg}", flush=True)


def describe_exit(code: int | None) -> str:
    if code is None:
        return "unknown"
    if code < 0:
        try:
            name = signal.Signals(-code).name
        except (ValueError, AttributeError):
            name = f"signal {-code}"
        if -code == 9:
            return f"killed by {name} (most likely out of memory)"
        return f"killed by {name}"
    # Windows reports a forced kill / some OOM aborts as large unsigned codes.
    return f"exit code {code}"


class Supervisor:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.state = "stopped"
        self.restarts = 0
        self.last_exit_code: int | None = None
        self.last_exit_reason: str | None = None
        self.last_exit_kind: str | None = None    # "crash" | "restart" (manual or watchdog)
        self.restart_reason: str = "restart requested"
        self.last_exit_at: float | None = None
        self.started_at: float | None = None
        self.healthy_at: float | None = None      # when the current process first became healthy
        self.last_health_ok: float | None = None
        self.rapid_crashes = 0
        self.wake = threading.Event()             # wakes the main loop (restart request / shutdown)
        self.restart_requested = False
        self.stopping = False

    # ------------------------------------------------------------ process control
    def _spawn(self) -> None:
        env = dict(os.environ)
        env["DEDRIS_SUPERVISED"] = "1"
        self.proc = subprocess.Popen([sys.executable, "server.py"], cwd=HERE, env=env)
        self.started_at = time.time()
        self.healthy_at = None
        self.last_health_ok = None
        self.state = "starting"
        log(f"engine started (pid {self.proc.pid})")

    def _kill(self) -> None:
        """Terminate the current child (SIGTERM, then SIGKILL after a grace)."""
        p = self.proc
        if p is None or p.poll() is not None:
            return
        log(f"stopping engine (pid {p.pid}) ...")
        try:
            p.terminate()
            p.wait(timeout=TERM_GRACE)
        except subprocess.TimeoutExpired:
            log("engine did not exit in time - killing it")
            p.kill()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        except OSError:
            pass

    def request_restart(self, reason: str) -> None:
        with self.lock:
            if self.stopping:
                return
            log(f"restart requested: {reason}")
            self.restart_requested = True
            self.restart_reason = reason
            self.state = "restarting"
            self.rapid_crashes = 0   # a manual/watchdog restart resets the crash budget
        # Kill outside the lock (it can block for the grace period); the main
        # loop sees the child exit, notices restart_requested and respawns.
        threading.Thread(target=self._kill, daemon=True).start()
        self.wake.set()

    def shutdown(self) -> None:
        with self.lock:
            self.stopping = True
            self.state = "stopped"
        self.wake.set()
        self._kill()

    # ------------------------------------------------------------ health watch
    def _probe(self) -> bool:
        try:
            with urllib.request.urlopen(f"http://{HOST}:{ENGINE_PORT}/api/health", timeout=5) as r:
                return r.status == 200
        except (urllib.error.URLError, OSError, ValueError):
            return False

    def health_loop(self) -> None:
        while not self.stopping:
            time.sleep(HEALTH_EVERY)
            with self.lock:
                p = self.proc
                alive = p is not None and p.poll() is None
                state = self.state
            if not alive or state in ("restarting", "stopped"):
                continue
            ok = self._probe()
            now = time.time()
            trigger = False
            with self.lock:
                if self.proc is not p or self.state in ("restarting", "stopped"):
                    continue
                if ok:
                    self.last_health_ok = now
                    if self.healthy_at is None:
                        self.healthy_at = now
                        log("engine is healthy")
                    if self.state != "running":
                        self.state = "running"
                elif self.healthy_at is not None:
                    # Was healthy before, now failing: unresponsive (maybe hung).
                    self.state = "unresponsive"
                    silent = now - (self.last_health_ok or now)
                    if WATCHDOG_SECS > 0 and silent >= WATCHDOG_SECS:
                        trigger = True
            if trigger:
                self.request_restart(f"engine unresponsive for {int(WATCHDOG_SECS)}s (watchdog)")

    # ------------------------------------------------------------ main loop
    def run(self) -> int:
        threading.Thread(target=self.health_loop, daemon=True).start()
        with self.lock:
            self._spawn()
        while True:
            p = self.proc
            # Wait for the child to exit (poll so a shutdown can interrupt us).
            while p is not None and p.poll() is None and not self.stopping:
                time.sleep(0.5)
            if self.stopping:
                self._kill()
                return 0

            code = p.poll() if p is not None else None
            with self.lock:
                manual = self.restart_requested
                self.restart_requested = False
                self.last_exit_code = code
                self.last_exit_at = time.time()
                self.last_exit_reason = self.restart_reason if manual else describe_exit(code)
                self.last_exit_kind = "restart" if manual else "crash"
                if not manual:
                    log(f"engine exited unexpectedly: {self.last_exit_reason}")
                    rapid = self.healthy_at is None or (self.last_exit_at - self.healthy_at) < RAPID_WINDOW
                    self.rapid_crashes = self.rapid_crashes + 1 if rapid else 1
                    self.state = "backoff"

            if not manual:
                if self.rapid_crashes >= MAX_RAPID_CRASHES:
                    with self.lock:
                        self.state = "failed"
                    log(f"engine crashed {self.rapid_crashes} times in a row - auto-restart paused. "
                        "Use the UI's restart button (or POST /restart) after fixing the cause.")
                    # Park until a manual restart or shutdown.
                    while True:
                        self.wake.wait()
                        self.wake.clear()
                        if self.stopping:
                            return 0
                        if self.restart_requested:
                            with self.lock:
                                self.restart_requested = False
                            break
                else:
                    delay = min(30.0, 3.0 * (2 ** (self.rapid_crashes - 1)))
                    log(f"restarting engine in {delay:.0f}s ...")
                    self.wake.clear()
                    self.wake.wait(delay)   # interruptible by Ctrl-C / manual restart
                    if self.stopping:
                        return 0
                    with self.lock:
                        self.restart_requested = False

            with self.lock:
                if self.stopping:
                    return 0
                self.restarts += 1
                self._spawn()

    # ------------------------------------------------------------ status
    def status(self) -> dict:
        with self.lock:
            p = self.proc
            now = time.time()
            return {
                "supervised": True,
                "state": self.state,
                "pid": p.pid if p is not None and p.poll() is None else None,
                "restarts": self.restarts,
                "uptime": round(now - self.started_at, 1) if self.started_at and p is not None and p.poll() is None else None,
                "last_health_ok_ago": round(now - self.last_health_ok, 1) if self.last_health_ok else None,
                "last_exit_code": self.last_exit_code,
                "last_exit_reason": self.last_exit_reason,
                "last_exit_kind": self.last_exit_kind,
                "last_exit_ago": round(now - self.last_exit_at, 1) if self.last_exit_at else None,
                "oom_suspected": self.last_exit_kind == "crash" and self.last_exit_code == -9,
                "watchdog_secs": WATCHDOG_SECS,
            }


SUP = Supervisor()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] == "/status":
            self._json(200, SUP.status())
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        if self.path.split("?")[0] == "/restart":
            SUP.request_restart("restart requested from the UI")
            self._json(202, {"ok": True, "state": "restarting"})
        else:
            self._json(404, {"error": "not_found"})

    def log_message(self, *args):  # keep the engine log clean
        pass


def main() -> int:
    try:
        httpd = ThreadingHTTPServer((HOST, SUPERVISOR_PORT), Handler)
    except OSError as e:
        log(f"cannot bind control port {HOST}:{SUPERVISOR_PORT} ({e}); "
            "the UI restart button will be unavailable")
        httpd = None
    if httpd is not None:
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        log(f"control API on http://{HOST}:{SUPERVISOR_PORT} (engine port {ENGINE_PORT})")

    def on_signal(signum, _frame):
        log(f"received {signal.Signals(signum).name} - shutting down")
        with SUP.lock:
            SUP.stopping = True
        SUP.wake.set()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    if hasattr(signal, "SIGBREAK"):   # Windows console close / Ctrl-Break
        signal.signal(signal.SIGBREAK, on_signal)

    try:
        return SUP.run()
    finally:
        SUP.shutdown()
        if httpd is not None:
            httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())
