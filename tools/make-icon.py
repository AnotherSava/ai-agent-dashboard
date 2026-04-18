"""
Generate a traffic-light icon for the widget tray/app icon.

Writes a multi-resolution .ico file at assets/ai-agent-dashboard.ico with
sizes [16, 24, 32, 48, 64, 128, 256]. Re-run whenever the palette or layout
changes; the .ico ships via electron-builder's files allowlist.

Colors match the widget's status palette:
  red    = #f85149 (error)
  orange = #f0883e (working)
  green  = #3fb950 (done)
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

COLORS = [
    (248, 81, 73),    # red    -- error
    (240, 136, 62),   # orange -- working
    (63, 185, 80),    # green  -- done
]
HOUSING_FILL = (22, 27, 34)       # #161b22 -- widget background
HOUSING_STROKE = (230, 237, 243)  # #e6edf3 -- visible on dark tray backgrounds


def draw_traffic_light(size: int) -> Image.Image:
    # Work at 4x supersample then downsample for clean edges at small sizes.
    scale = 4 if size < 64 else 2
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = max(1, s // 10)
    corner = max(2, s // 8)
    d.rounded_rectangle(
        [pad, pad, s - 1 - pad, s - 1 - pad],
        radius=corner,
        fill=HOUSING_FILL,
        outline=HOUSING_STROKE,
        width=max(2, s // 40),
    )

    housing_top = pad
    housing_bot = s - 1 - pad
    housing_h = housing_bot - housing_top
    # 3 circles + 4 gaps (top, between x2, bottom). Circle diameter = housing_h / 4.5.
    diam = housing_h / 4.5
    gap = (housing_h - 3 * diam) / 4
    cx = s / 2

    for i, color in enumerate(COLORS):
        cy = housing_top + gap + diam / 2 + i * (diam + gap)
        r = diam / 2
        # Soft glow: a slightly larger, dimmer circle underneath.
        glow_r = r * 1.18
        glow = tuple(min(255, int(c * 0.45)) for c in color) + (180,)
        d.ellipse([cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r], fill=glow)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (255,))

    # Downsample with antialiasing.
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    # Draw once at 256 with heavy supersampling; PIL downscales for each ICO entry.
    base = draw_traffic_light(256)
    out = Path(__file__).resolve().parent.parent / "assets" / "ai-agent-dashboard.ico"
    base.save(out, format="ICO", sizes=[(s, s) for s in sizes])
    print(f"wrote {out} ({len(sizes)} sizes: {sizes})")


if __name__ == "__main__":
    main()
