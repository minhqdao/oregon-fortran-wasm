#!/usr/bin/env python3
"""
Generates the Oregon Trail favicon set: a retro, pixel-art covered wagon
(Conestoga "cart") in the site's neon terminal green (#c8f8c8) on the
terminal's dark background (#111512).

The artwork is authored once as a 32x32 pixel grid and then derived, via
nearest-neighbour sampling, into:

  web/favicon.svg          self-contained pixel-grid SVG (crispEdges)
  web/favicon-16.png       16x16  PNG
  web/favicon-32.png       32x32  PNG
  web/favicon-48.png       48x48  PNG
  web/apple-touch-icon.png 180x180 PNG

No third-party libraries are required: PNGs are encoded with the standard
library only (zlib + struct).

Usage: python3 scripts/make-favicon.py
"""

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

# Palette (matches web/index.html).
BG = (0x11, 0x15, 0x12)  # #111512 - terminal background
GREEN = (0xC8, 0xF8, 0xC8)  # #c8f8c8 - site's neon terminal green

SIZE = 32  # base artwork resolution


def new_grid(size=SIZE):
    """A size x size grid of 0 (background) / 1 (green)."""
    return [[0] * size for _ in range(size)]


def px(g, x, y, v=1):
    n = len(g)
    if 0 <= x < n and 0 <= y < n:
        g[y][x] = v


def hline(g, x1, x2, y, v=1):
    for x in range(x1, x2 + 1):
        px(g, x, y, v)


def vline(g, x, y1, y2, v=1):
    for y in range(y1, y2 + 1):
        px(g, x, y, v)


def line(g, x1, y1, x2, y2, v=1):
    """Bresenham's line algorithm."""
    dx = abs(x2 - x1)
    dy = -abs(y2 - y1)
    sx = 1 if x1 < x2 else -1
    sy = 1 if y1 < y2 else -1
    err = dx + dy
    while True:
        px(g, x1, y1, v)
        if x1 == x2 and y1 == y2:
            return
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x1 += sx
        if e2 <= dx:
            err += dx
            y1 += sy


def ring(g, cx, cy, r, v=1):
    """Midpoint circle algorithm outline."""
    x = r
    y = 0
    err = 0
    while x >= y:
        for dx, dy in ((x, y), (y, x), (-x, y), (-y, x),
                       (x, -y), (y, -x), (-x, -y), (-y, -x)):
            px(g, cx + dx, cy + dy, v)
        if err <= 0:
            y += 1
            err += 2 * y + 1
        if err > 0:
            x -= 1
            err -= 2 * x + 1


def disk(g, cx, cy, r, v=1):
    for y in range(-r, r + 1):
        dx = int(round(math.sqrt(max(r * r - y * y, 0))))
        hline(g, cx - dx, cx + dx, cy + y, v)


def fill_circle_upper(g, cx, cy, r, clip=None, v=1):
    """Filled upper half of a disk (the canvas roof), optionally clipped
    horizontally to clip=(xmin, xmax)."""
    for y in range(-r, 1):  # y offset: from top of circle down to centre
        dy = cy + y
        chord = int(math.floor(math.sqrt(max(r * r - y * y, 0))))
        x1 = cx - chord
        x2 = cx + chord
        if clip:
            x1 = max(x1, clip[0])
            x2 = min(x2, clip[1])
        if x1 <= x2:
            hline(g, x1, x2, dy, v)


def build_wagon():
    """A 32x32 retro pixel-art wild-west covered wagon facing right.

    Layout (side view, matching the reference icon):
        canvas cover (y  4..14)  flared trapezoid, wavy scalloped top edge
        gap          (y 15)      background row separating cover and bed
        wagon bed    (y 16..21)  solid bar, arch cut-outs over the wheels,
                                 tongue stub at the bottom right
        wheels       (y 20..30)  spoked wheels; front (right) slightly smaller
    """
    g = new_grid()

    # --- Canvas cover: wider at the top, wavy scalloped roof -------------
    top_y, bot_y = 4, 14
    peaks = (3, 12, 20, 29)  # x positions of the scallop points

    def top_edge(x):
        for a, b in zip(peaks, peaks[1:]):  # three concave dips between peaks
            if a <= x <= b:
                mid, half = (a + b) / 2.0, (b - a) / 2.0
                return top_y + round(2 * (1 - ((x - mid) / half) ** 2))
        return top_y

    for y in range(top_y, bot_y + 1):
        xl = round(3 + (y - top_y) * 0.2)  # sides slant inwards going down
        xr = round(29 - (y - top_y) * 0.2)
        for x in range(xl, xr + 1):
            if y >= top_edge(x):
                px(g, x, y)

    # --- Wheels: same spoked style, right (front) one slightly smaller ---
    back_cx, back_r = 9, 5
    front_cx, front_r = 22, 4
    wcy = 25
    for cx, r in ((back_cx, back_r), (front_cx, front_r)):
        ring(g, cx, wcy, r)  # outer tyre
        for ang in range(0, 360, 45):  # eight thin spokes
            a = math.radians(ang)
            ex, ey = round(math.cos(a) * r), round(math.sin(a) * r)
            line(g, cx, wcy, cx + ex, wcy + ey)
        disk(g, cx, wcy, 1)  # hub cap

    # --- Wagon bed: solid bar with arch cut-outs over the wheels ---------
    bed_top, bed_bot = 16, 21
    for y in range(bed_top, bed_bot + 1):
        for x in range(5, 28):
            if math.hypot(x - back_cx, y - wcy) <= back_r + 1:
                continue  # arch over the back wheel
            if math.hypot(x - front_cx, y - wcy) <= front_r + 1:
                continue  # arch over the front wheel
            px(g, x, y)
    hline(g, 28, 29, bed_bot)  # tongue stub at the bottom right

    return g


def build_grid():
    return build_wagon()


def scale(grid, new_w, new_h):
    """Nearest-neighbour scale of a 0/1 grid."""
    ow, oh = len(grid[0]), len(grid)
    out = [[0] * new_w for _ in range(new_h)]
    for ny in range(new_h):
        iy = min(int(ny * oh / new_h), oh - 1)
        row_src = grid[iy]
        for nx in range(new_w):
            ix = min(int(nx * ow / new_w), ow - 1)
            out[ny][nx] = row_src[ix]
    return out


def grid_to_png_bytes(grid, w, h):
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type: None
        for x in range(w):
            r, g, b = GREEN if grid[y][x] else BG
            raw += bytes((r, g, b))
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit, truecolour RGB
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


def grid_to_svg(grid, size=SIZE):
    """Self-contained pixel-grid SVG. Each row's run of green pixels becomes a
    single <rect> (run-length), keeping the file small while `crispEdges`
    guarantees the pixels stay sharp at any scale."""
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" '
        'shape-rendering="crispEdges">' % (size, size),
        '  <rect width="%d" height="%d" fill="#%02x%02x%02x"/>'
        % (size, size, *BG),
    ]
    gx = GREEN
    for y in range(size):
        x = 0
        while x < size:
            if grid[y][x]:
                x0 = x
                while x < size and grid[y][x]:
                    x += 1
                parts.append('  <rect x="%d" y="%d" width="%d" height="1" '
                             'fill="#%02x%02x%02x"/>' % (x0, y, x - x0, *gx))
            else:
                x += 1
    parts.append('</svg>')
    return "\n".join(parts) + "\n"


def print_ascii(grid, size=None):
    size = size or len(grid)
    print("  " + "".join(str(x % 10) for x in range(size)))
    for y in range(size):
        print("%2d" % y, end=" ")
        print("".join("#" if grid[y][x] else "." for x in range(size)))


def main():
    grid = build_grid()
    print("=== base artwork (%dx%d) ===" % (SIZE, SIZE))
    print_ascii(grid)

    # SVG (self-contained, pixel grid, crisp edges).
    (WEB / "favicon.svg").write_text(grid_to_svg(grid), encoding="utf-8")

    # PNGs at every size browsers ask for, nearest-neighbour (no blur).
    targets = ((16, "favicon-16.png"), (32, "favicon-32.png"),
               (48, "favicon-48.png"), (180, "apple-touch-icon.png"))
    for n, name in targets:
        scaled = scale(grid, n, n)
        png = grid_to_png_bytes(scaled, n, n)
        (WEB / name).write_bytes(png)
        print("wrote web/%s (%dx%d, %d bytes)" % (name, n, n, len(png)))


if __name__ == "__main__":
    main()
