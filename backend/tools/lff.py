"""Minimal LibreCAD .lff stroke-font parser (used only to bootstrap glyph labels).

Font files are not shipped with the project; pass a directory of .lff files.
"""
import math
import re
from pathlib import Path


def _arc(p0, p1, bulge, n=8):
    """Approximate a bulge arc from p0 to p1 with n segments."""
    if abs(bulge) < 1e-9:
        return [p1]
    (x0, y0), (x1, y1) = p0, p1
    ang = 4 * math.atan(bulge)
    d = math.hypot(x1 - x0, y1 - y0)
    if d == 0:
        return [p1]
    r = d / (2 * math.sin(ang / 2))
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    h = r * math.cos(ang / 2)
    ux, uy = (x1 - x0) / d, (y1 - y0) / d
    cx, cy = mx - uy * h, my + ux * h
    a0 = math.atan2(y0 - cy, x0 - cx)
    pts = []
    for i in range(1, n + 1):
        a = a0 + ang * i / n
        pts.append((cx + abs(r) * math.cos(a) * (1 if r > 0 else 1), cy + abs(r) * math.sin(a)))
    pts[-1] = p1
    return pts


def parse_lff(path):
    glyphs, raw = {}, {}
    cur = None
    for line in Path(path).read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"\[#?([0-9A-Fa-f]{4,})\]", line)
        if m:
            cur = chr(int(m.group(1), 16))
            raw[cur] = []
            continue
        if cur is not None:
            raw[cur].append(line)

    def build(ch, depth=0):
        if ch in glyphs:
            return glyphs[ch]
        polys = []
        for line in raw.get(ch, []):
            if line.startswith("C"):
                ref = chr(int(line[1:5], 16))
                if depth < 3 and ref in raw:
                    polys.extend(build(ref, depth + 1))
                continue
            pts = []
            for v in line.split(";"):
                parts = v.split(",")
                try:
                    x, y = float(parts[0]), float(parts[1])
                except (ValueError, IndexError):
                    continue
                bulge = 0.0
                if len(parts) > 2 and parts[2].startswith("A"):
                    try:
                        bulge = float(parts[2][1:])
                    except ValueError:
                        pass
                if pts and bulge:
                    pts.extend(_arc(pts[-1], (x, y), bulge))
                else:
                    pts.append((x, y))
            if pts:
                polys.append(pts)
        glyphs[ch] = polys
        return polys

    for ch in raw:
        build(ch)
    return glyphs
