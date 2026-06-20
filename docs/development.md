# Development

The Python generation engine lives under `engine/`. Run all engine commands from inside that
directory (the engine expects its working directory to be `engine/`).

## Running unit tests

From the `engine/` directory, using native Python:

```
cd engine
python -m unittest tests/
```

Using the portable Python runtime provisioned by the launchers:

```
cd engine
../runtimes/python/win/python.exe -m unittest    # Windows
../runtimes/python/mac/bin/python -m unittest     # macOS
```

## Running the engine directly

The launchers (`start.bat` / `start.command`) start the HTTP service `engine/server.py` for you. For
debugging you can also run the engine the legacy way:

```
cd engine
python launch.py
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how the PHP UI and the engine fit together.
