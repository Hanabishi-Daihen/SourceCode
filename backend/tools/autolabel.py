"""Auto-label glyph clusters against LibreCAD stroke fonts and draw review sheets.

usage: autolabel.py clusters.json FONTDIR OUT_DIR
Writes OUT_DIR/labels.json  {cluster_index: [label, rot, score]} and review sheets
grouped by label (OUT_DIR/review_*.png) so a human can verify them quickly.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
from PIL import Image, ImageDraw

from schcheck.glyphs import descriptor
from lff import parse_lff

FONTS = ["romans", "simplex", "iso", "iso3098", "standard", "romanc", "romand", "romansi", "italicc"]
CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-/.,:()+=_%&#<>'\"*~[]°Ω?!;"


def rot_polys(polys, rot):
    if rot == 0:
        return polys
    h = max(p[1] for pl in polys for p in pl) - min(p[1] for pl in polys for p in pl)
    return [[(h - y, x) for x, y in pl] for pl in polys]


def templates(fontdir):
    T = []
    for f in FONTS:
        p = Path(fontdir) / f"{f}.lff"
        if not p.exists():
            continue
        g = parse_lff(p)
        for ch in CHARS:
            polys = g.get(ch)
            if not polys:
                continue
            polys = [[(x, -y) for x, y in pl] for pl in polys]  # font y-up -> display y-down
            v, w, h, asp = descriptor(polys)
            T.append((ch, f, v, asp))
    return T


def render(polys, size=56):
    xs = [p[0] for pl in polys for p in pl]
    ys = [p[1] for pl in polys for p in pl]
    mx, my = min(xs), min(ys)
    s = max(max(xs) - mx, max(ys) - my, 1e-6)
    im = Image.new("L", (size, size), 255)
    d = ImageDraw.Draw(im)
    k = (size - 8) / s
    for pl in polys:
        pts = [(4 + (x - mx) * k, 4 + (y - my) * k) for x, y in pl]
        if len(pts) == 1:
            pts = pts * 2
        d.line(pts, fill=0, width=2)
    return im


def main():
    clusters = json.load(open(sys.argv[1]))
    T = templates(sys.argv[2])
    out = Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    TV = np.stack([t[2] for t in T])
    TA = np.array([t[3] for t in T])
    labels = {}
    for i, c in enumerate(clusters):
        best = None
        for rot in (0, 1):
            polys = rot_polys(c["polys"], rot)
            v, w, h, asp = descriptor(polys)
            sims = TV @ v - 0.5 * np.abs(np.log(TA / asp))
            k = int(np.argmax(sims))
            sc = float(sims[k]) - (0.03 if rot else 0.0)
            if best is None or sc > best[2]:
                best = (T[k][0], rot, sc)
        labels[i] = best
    json.dump(labels, open(out / "labels.json", "w"))

    # review sheets grouped by label, frequent clusters first
    groups = {}
    for i, (lab, rot, sc) in labels.items():
        groups.setdefault(lab, []).append(i)
    cells = []
    for lab in sorted(groups):
        for i in sorted(groups[lab], key=lambda i: -clusters[i]["n"]):
            if clusters[i]["n"] >= 2:
                cells.append(i)
    CW, CH, COLS, ROWS = 120, 80, 12, 12
    for si in range(0, len(cells), COLS * ROWS):
        sheet = Image.new("RGB", (CW * COLS, CH * ROWS), "white")
        d = ImageDraw.Draw(sheet)
        for j, i in enumerate(cells[si:si + COLS * ROWS]):
            lab, rot, sc = labels[i]
            cx, cy = (j % COLS) * CW, (j // COLS) * CH
            sheet.paste(render(rot_polys(clusters[i]["polys"], rot)).convert("RGB"), (cx + 60, cy + 12))
            d.text((cx + 3, cy + 3), f"#{i}", fill=(0, 0, 255))
            d.text((cx + 3, cy + 20), f"'{lab}' r{rot}", fill=(200, 0, 0))
            d.text((cx + 3, cy + 37), f"{sc:.2f}", fill=(0, 0, 0))
            d.text((cx + 3, cy + 54), f"n={clusters[i]['n']}", fill=(90, 90, 90))
            d.rectangle([cx, cy, cx + CW - 1, cy + CH - 1], outline=(210, 210, 210))
        sheet.save(out / f"review_{si // (COLS * ROWS):02d}.png")
    print(len(cells), "cells", file=sys.stderr)


if __name__ == "__main__":
    main()
