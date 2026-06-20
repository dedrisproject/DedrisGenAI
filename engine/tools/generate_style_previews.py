#!/usr/bin/env python3
"""
DedrisGenAI — style preview generator.

Every style the engine exposes should have a preview thumbnail the PHP web UI
can show in the (searchable) style picker. This CLI produces those thumbnails
under ``engine/sdxl_styles/previews/<slug>.jpg`` where the ``<slug>`` rule is the
SAME one ``server.py`` and ``javascript/script.js`` use:

    slug = name.lower().replace(' ', '_')

Two modes
=========

``--placeholders`` (NO models, NO torch required)
    For every style name, draw a pleasing deterministic gradient (seeded from a
    hash of the style name, so the same style always gets the same look) with the
    style name rendered centered on top, using Pillow. Styles that already ship a
    real sample at ``sdxl_styles/samples/<slug>.jpg`` are SKIPPED unless
    ``--force`` is given. This mode runs anywhere Pillow is installed.

default mode — real previews (NEEDS models + torch; do not run without them)
    Render one genuine example image per style by driving the EXACT same worker
    flow ``server.py`` uses: a fixed neutral prompt + that single style, then
    save the first result to ``previews/<slug>.jpg``. Honors ``--prompt``,
    ``--limit`` and ``--only``. The heavy imports (``server`` / ``modules.*`` /
    torch) happen INSIDE the function, so this module stays import-safe and
    ``python3 -m py_compile`` passes with no torch and no models present.

Examples
========
    # populate placeholders for every style lacking a real sample (safe here):
    python tools/generate_style_previews.py --placeholders

    # regenerate ALL placeholders, even where a real sample exists:
    python tools/generate_style_previews.py --placeholders --force

    # REAL previews (only on a machine with torch + the models downloaded):
    python tools/generate_style_previews.py --limit 5
    python tools/generate_style_previews.py --only "DedrisGenAI Sharp"
    python tools/generate_style_previews.py --prompt "a cozy reading nook"

Run with CWD = engine/ (same as server.py / launch.py), or from anywhere — the
paths below are resolved relative to this file, not the process CWD.
"""

import os
import re
import sys
import json
import math
import hashlib
import argparse

# ---------------------------------------------------------------------------
# Paths — resolved from this file so the tool works regardless of CWD.
# engine/tools/generate_style_previews.py  ->  ENGINE_ROOT = engine/
# ---------------------------------------------------------------------------
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_ROOT = os.path.dirname(TOOLS_DIR)
STYLES_DIR = os.path.join(ENGINE_ROOT, "sdxl_styles")
SAMPLES_DIR = os.path.join(STYLES_DIR, "samples")
PREVIEWS_DIR = os.path.join(STYLES_DIR, "previews")

# Thumbnail geometry / typography.
PREVIEW_SIZE = 320  # square px


# ---------------------------------------------------------------------------
# Style discovery — mirror modules/sdxl_styles.py exactly so names match the
# engine's legal_style_names (and therefore the slugs server.py looks up).
# ---------------------------------------------------------------------------

def normalize_key(k):
    """Identical to modules.sdxl_styles.normalize_key (kept local so this tool
    needs no torch-importing module on the placeholder path)."""
    k = k.replace('-', ' ')
    words = k.split(' ')
    words = [w[:1].upper() + w[1:].lower() for w in words]
    k = ' '.join(words)
    k = k.replace('3d', '3D')
    k = k.replace('Sai', 'SAI')
    k = k.replace('Mre', 'MRE')
    k = k.replace('(s', '(S')
    # Preserve DedrisGenAI brand casing (title-casing lowercases the inner caps).
    k = k.replace('Dedrisgenai', 'DedrisGenAI')
    return k


def slug_for(name):
    """The canonical filename stem for a style — must match server.py."""
    return name.lower().replace(" ", "_")


def discover_style_names():
    """Return the de-duplicated, ordered list of style display names read from
    sdxl_styles/*.json, the same set modules/sdxl_styles.py loads. The load
    order matches sdxl_styles.py (the listed brand/family files moved to the end)
    so later files win on name collisions, exactly as the engine does."""
    if not os.path.isdir(STYLES_DIR):
        raise SystemExit(f"styles dir not found: {STYLES_DIR}")

    styles_files = sorted(
        [f for f in os.listdir(STYLES_DIR) if f.lower().endswith(".json")],
        key=lambda s: s.casefold(),
    )
    # Same precedence shuffle sdxl_styles.py applies (moves these to the tail).
    for x in ['sdxl_styles_dedris.json',
              'sdxl_styles_sai.json',
              'sdxl_styles_mre.json',
              'sdxl_styles_twri.json',
              'sdxl_styles_diva.json',
              'sdxl_styles_marc_k3nt3l.json']:
        if x in styles_files:
            styles_files.remove(x)
            styles_files.append(x)

    names = []
    seen = set()
    for fn in styles_files:
        try:
            with open(os.path.join(STYLES_DIR, fn), encoding="utf-8") as f:
                for entry in json.load(f):
                    name = normalize_key(entry["name"])
                    if name not in seen:
                        seen.add(name)
                        names.append(name)
        except Exception as e:  # pragma: no cover - defensive, mirror engine
            print(f"[previews] failed to load {fn}: {e}", file=sys.stderr)
    return names


def has_real_sample(name):
    return os.path.isfile(os.path.join(SAMPLES_DIR, slug_for(name) + ".jpg"))


# ---------------------------------------------------------------------------
# Placeholder rendering (Pillow only — no torch, no models)
# ---------------------------------------------------------------------------

def _seed_from_name(name):
    """Deterministic integer seed derived from the style name."""
    h = hashlib.sha256(name.encode("utf-8")).hexdigest()
    return int(h[:16], 16)


def _hsv_to_rgb(h, s, v):
    """h in [0,1), s,v in [0,1] -> (r,g,b) 0-255 ints."""
    i = int(h * 6.0)
    f = h * 6.0 - i
    p = v * (1.0 - s)
    q = v * (1.0 - s * f)
    t = v * (1.0 - s * (1.0 - f))
    i %= 6
    r, g, b = [
        (v, t, p), (q, v, p), (p, v, t),
        (p, q, v), (t, p, v), (v, p, q),
    ][i]
    return (int(r * 255), int(g * 255), int(b * 255))


def _gradient_colors(name):
    """Two deterministic, harmonious endpoint colors for the gradient."""
    seed = _seed_from_name(name)
    base_hue = (seed % 360) / 360.0
    # second hue: analogous/complementary offset chosen from the hash
    offset_choices = (0.08, 0.5, 0.62, 0.16, 0.33)
    offset = offset_choices[(seed >> 8) % len(offset_choices)]
    sat = 0.45 + ((seed >> 16) % 35) / 100.0   # 0.45 .. 0.80
    val_top = 0.78 + ((seed >> 24) % 18) / 100.0  # bright top
    val_bot = 0.32 + ((seed >> 32) % 22) / 100.0  # darker bottom for readability
    c1 = _hsv_to_rgb(base_hue % 1.0, sat, min(val_top, 1.0))
    c2 = _hsv_to_rgb((base_hue + offset) % 1.0, min(sat + 0.1, 1.0), val_bot)
    return c1, c2, base_hue


def _load_font(size):
    """Find a readable bold TTF; fall back to Pillow's default bitmap font."""
    from PIL import ImageFont
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "C:\\Windows\\Fonts\\arialbd.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size)  # Pillow >= 10
    except TypeError:
        return ImageFont.load_default()


def _wrap_text(draw, text, font, max_width):
    """Greedy word-wrap so the style name fits the thumbnail width."""
    words = text.split()
    if not words:
        return [text]
    lines = []
    cur = words[0]
    for w in words[1:]:
        trial = cur + " " + w
        if draw.textlength(trial, font=font) <= max_width:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def _text_size(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def render_placeholder(name, size=PREVIEW_SIZE):
    """Return a PIL.Image: a deterministic diagonal gradient (seeded from the
    style name) with the name drawn centered, wrapped, on a subtle scrim for
    readability."""
    from PIL import Image, ImageDraw, ImageFilter

    c1, c2, base_hue = _gradient_colors(name)

    # Build a vertical gradient then add a faint diagonal tint for depth.
    base = Image.new("RGB", (size, size), c1)
    px = base.load()
    for y in range(size):
        ty = y / max(size - 1, 1)
        for x in range(size):
            tx = x / max(size - 1, 1)
            # blend mostly along y, with a gentle diagonal contribution
            t = 0.75 * ty + 0.25 * tx
            r = int(c1[0] + (c2[0] - c1[0]) * t)
            g = int(c1[1] + (c2[1] - c1[1]) * t)
            b = int(c1[2] + (c2[2] - c1[2]) * t)
            px[x, y] = (r, g, b)

    draw = ImageDraw.Draw(base, "RGBA")

    # Two soft accent circles (a third gradient endpoint hue) for visual interest.
    accent = _hsv_to_rgb((base_hue + 0.5) % 1.0, 0.55, 0.95)
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    r1 = int(size * 0.42)
    odraw.ellipse([size - r1, -r1 // 2, size + r1, r1 + r1 // 2],
                  fill=accent + (46,))
    r2 = int(size * 0.30)
    odraw.ellipse([-r2, size - r2, r2, size + r2], fill=accent + (38,))
    overlay = overlay.filter(ImageFilter.GaussianBlur(size * 0.05))
    base = Image.alpha_composite(base.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(base, "RGBA")

    # Typography: scale font to fit, wrap, draw a translucent scrim behind text.
    margin = int(size * 0.10)
    max_text_w = size - 2 * margin
    font_size = int(size * 0.16)
    font = _load_font(font_size)
    lines = _wrap_text(draw, name, font, max_text_w)
    # shrink the font if too many lines / too tall
    while font_size > 12:
        lines = _wrap_text(draw, name, font, max_text_w)
        line_h = _text_size(draw, "Ag", font)[1] + int(font_size * 0.25)
        total_h = line_h * len(lines)
        widest = max((draw.textlength(ln, font=font) for ln in lines), default=0)
        if total_h <= size - 2 * margin and widest <= max_text_w:
            break
        font_size = int(font_size * 0.9)
        font = _load_font(font_size)

    line_h = _text_size(draw, "Ag", font)[1] + int(font_size * 0.25)
    total_h = line_h * len(lines)
    y0 = (size - total_h) // 2

    # scrim behind text for contrast on any gradient
    pad = int(font_size * 0.5)
    scrim_top = y0 - pad
    scrim_bot = y0 + total_h + pad
    draw.rectangle([0, scrim_top, size, scrim_bot], fill=(0, 0, 0, 90))

    y = y0
    for ln in lines:
        w = draw.textlength(ln, font=font)
        x = (size - w) / 2
        # subtle shadow for legibility
        draw.text((x + 2, y + 2), ln, font=font, fill=(0, 0, 0, 160))
        draw.text((x, y), ln, font=font, fill=(255, 255, 255, 255))
        y += line_h

    return base


def generate_placeholders(force=False, only=None, limit=None, out_dir=PREVIEWS_DIR):
    """Generate placeholder thumbnails. Returns (generated, skipped, total)."""
    try:
        import PIL  # noqa: F401
    except Exception:
        raise SystemExit(
            "Pillow is required for --placeholders. Install it (pip install pillow)."
        )

    os.makedirs(out_dir, exist_ok=True)
    names = discover_style_names()
    if only:
        wanted = {normalize_key(o) for o in only}
        names = [n for n in names if n in wanted]
        missing = wanted - set(names)
        for m in sorted(missing):
            print(f"[previews] --only style not found, skipped: {m!r}", file=sys.stderr)

    total = len(names)
    generated = 0
    skipped = 0
    for name in names:
        if limit is not None and generated >= limit:
            break
        slug = slug_for(name)
        if not force and has_real_sample(name):
            skipped += 1
            continue
        out_path = os.path.join(out_dir, slug + ".jpg")
        img = render_placeholder(name)
        img.save(out_path, format="JPEG", quality=88, optimize=True)
        generated += 1
        print(f"[previews] placeholder -> {os.path.relpath(out_path, ENGINE_ROOT)}")

    return generated, skipped, total


# ---------------------------------------------------------------------------
# Real previews (needs torch + models) — heavy imports kept INSIDE the function
# so this module imports / py_compiles fine without them.
# ---------------------------------------------------------------------------

def generate_real_previews(prompt=None, only=None, limit=None, out_dir=PREVIEWS_DIR,
                           poll_interval=1.0, timeout=600.0):
    """Render one genuine example image per style by driving the SAME worker flow
    server.py uses (neutral prompt + the single style), saving the first result
    to previews/<slug>.jpg.

    Requires torch and the engine models to be present. Run only on a CUDA/MPS
    machine with the models downloaded (see DEDRIS_SPEC.md §6). All heavy imports
    happen here, not at module import time.
    """
    import time

    # Import server.py as a module so we reuse its exact bootstrap + task assembly.
    if ENGINE_ROOT not in sys.path:
        sys.path.insert(0, ENGINE_ROOT)
    import server  # noqa: E402  (engine/server.py)

    server.bootstrap()  # downloads/links models, starts the worker thread

    os.makedirs(out_dir, exist_ok=True)
    neutral_prompt = prompt if prompt is not None else (
        "a photo of a corgi sitting on a wooden table, centered, studio lighting"
    )

    names = discover_style_names()
    if only:
        wanted = {server.sdxl_styles.normalize_key(o) if hasattr(server, "sdxl_styles")
                  else normalize_key(o) for o in only}
        names = [n for n in names if n in wanted]
    if limit is not None:
        names = names[:limit]

    generated = 0
    for name in names:
        slug = slug_for(name)
        out_path = os.path.join(out_dir, slug + ".jpg")
        print(f"[previews] rendering REAL preview for {name!r} ...")

        body = {
            "prompt": neutral_prompt,
            "negative_prompt": "",
            "style_selections": [name],
            "image_number": 1,
            "output_format": "png",
            "performance": "Speed",
        }
        info = server.start_generation(body)
        task_id = info["task_id"]

        # Poll progress until the task finishes, then copy its first image.
        deadline = time.time() + timeout
        result_images = []
        while time.time() < deadline:
            prog = server.get_progress(task_id)
            state = prog.get("state")
            if state in ("done", "stopped", "error"):
                result_images = prog.get("images", []) or []
                break
            time.sleep(poll_interval)

        if not result_images:
            print(f"[previews] no image produced for {name!r}; skipped", file=sys.stderr)
            continue

        # result_images are /outputs/<rel> URLs -> resolve to absolute file paths.
        rel = result_images[0].split("/outputs/", 1)[-1]
        src = os.path.join(os.path.abspath(server.config.path_outputs), rel)
        if not os.path.isfile(src):
            print(f"[previews] result file missing for {name!r}: {src}", file=sys.stderr)
            continue

        from PIL import Image
        img = Image.open(src).convert("RGB")
        img.save(out_path, format="JPEG", quality=90, optimize=True)
        generated += 1
        print(f"[previews] real preview -> {os.path.relpath(out_path, ENGINE_ROOT)}")

    return generated


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(
        prog="generate_style_previews.py",
        description="Generate per-style preview thumbnails for the DedrisGenAI UI.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--placeholders", action="store_true",
                   help="Generate Pillow placeholder thumbnails (no models/torch needed).")
    p.add_argument("--force", action="store_true",
                   help="Overwrite even styles that already ship a real sample.")
    p.add_argument("--only", action="append", default=None, metavar="NAME",
                   help="Limit to this style name (repeatable).")
    p.add_argument("--limit", type=int, default=None, metavar="N",
                   help="Process at most N styles.")
    p.add_argument("--prompt", default=None, metavar="TEXT",
                   help="(real mode) neutral prompt to render each style with.")
    p.add_argument("--out-dir", default=PREVIEWS_DIR, metavar="DIR",
                   help="Output directory (default: sdxl_styles/previews/).")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.placeholders:
        generated, skipped, total = generate_placeholders(
            force=args.force, only=args.only, limit=args.limit, out_dir=args.out_dir,
        )
        print(f"\n[previews] placeholders: generated={generated} "
              f"skipped(real sample present)={skipped} total_styles={total}")
        print(f"[previews] output dir: {args.out_dir}")
        return 0

    # default: real previews (needs torch + models)
    print("[previews] REAL preview mode — this requires torch and the engine "
          "models. Use --placeholders for the model-free path.")
    generated = generate_real_previews(
        prompt=args.prompt, only=args.only, limit=args.limit, out_dir=args.out_dir,
    )
    print(f"\n[previews] real previews generated={generated}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
