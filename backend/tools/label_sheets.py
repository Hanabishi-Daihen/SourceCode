"""Pick representative clusters and draw labelling sheets (glyph + page context).

usage: label_sheets.py clusters.json OUT_DIR [min_n] [thr]
Writes OUT_DIR/reps.json (cluster ids in sheet order) and OUT_DIR/label_XX.png.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pymupdf
from PIL import Image, ImageDraw

from schcheck.glyphs import descriptor
from autolabel import render

clusters = json.load(open(sys.argv[1]))
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
min_n = int(sys.argv[3]) if len(sys.argv) > 3 else 3
thr = float(sys.argv[4]) if len(sys.argv) > 4 else 0.85

D = [descriptor(c["polys"]) for c in clusters]
V = np.stack([d[0] for d in D])
A = np.array([d[3] for d in D])
n = np.array([c["n"] for c in clusters])
reps = []
for i in np.argsort(-n):
    if n[i] < min_n:
        continue
    if reps:
        R = np.array(reps)
        if (V[R] @ V[i] - 0.5 * np.abs(np.log(A[R] / A[i]))).max() >= thr:
            continue
    reps.append(int(i))
json.dump(reps, open(out / "reps.json", "w"))

docs = {}
CW, CH, COLS, ROWS = 250, 76, 6, 12
for si in range(0, len(reps), COLS * ROWS):
    sheet = Image.new("RGB", (CW * COLS, CH * ROWS), "white")
    d = ImageDraw.Draw(sheet)
    for j, i in enumerate(reps[si:si + COLS * ROWS]):
        c = clusters[i]
        cx, cy = (j % COLS) * CW, (j // COLS) * CH
        sheet.paste(render(c["polys"], 60).convert("RGB"), (cx + 30, cy + 8))
        doc = docs.setdefault(c["pdf"], pymupdf.open(c["pdf"]))
        x0, y0, x1, y1 = c["bbox"]
        hh = max(y1 - y0, x1 - x0, 2.0)
        clip = pymupdf.Rect(x0 - 3 * hh, y0 - 1.2 * hh, x1 + 3 * hh, y1 + 1.2 * hh)
        zoom = min(150 / clip.width, 66 / clip.height)
        pix = doc[c["page"] - 1].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip)
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        ImageDraw.Draw(im).rectangle([(x0 - clip.x0) * zoom - 2, (y0 - clip.y0) * zoom - 2,
                                      (x1 - clip.x0) * zoom + 2, (y1 - clip.y0) * zoom + 2], outline=(255, 0, 0))
        sheet.paste(im, (cx + 95, cy + 5))
        d.text((cx + 2, cy + 2), str(j + si), fill=(0, 0, 255))
        d.rectangle([cx, cy, cx + CW - 1, cy + CH - 1], outline=(190, 190, 190))
    sheet.save(out / f"label_{si // (COLS * ROWS):02d}.png")
print(len(reps), "reps", file=sys.stderr)
