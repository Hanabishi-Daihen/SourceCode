"""Second labelling pass: clusters not close to any labelled representative.

usage: label_sheets2.py clusters.json LAB_DIR [thr]
Uses LAB_DIR/reps.json + labels_*.txt, writes LAB_DIR/reps2.json, LAB_DIR/prop2.json
(proposed tokens) and LAB_DIR/label2_XX.png showing the proposal for each cell.
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
lab = Path(sys.argv[2])
thr = float(sys.argv[3]) if len(sys.argv) > 3 else 0.9
reps = json.load(open(lab / "reps.json"))
tokens = []
for f in sorted(lab.glob("labels_*.txt")):
    tokens.extend(f.read_text().split())
D = [descriptor(c["polys"]) for c in clusters]
V = np.stack([d[0] for d in D])
A = np.log(np.array([d[3] for d in D]))
n = np.array([c["n"] for c in clusters])
R = np.array(reps)
rs = set(reps)
todo, prop = [], []
for i in np.argsort(-n):
    if i in rs or n[i] < 2:
        continue
    s = V[R] @ V[i] - 0.5 * np.abs(A[R] - A[i])
    k = int(np.argmax(s))
    if s[k] < thr:
        todo.append(int(i))
        prop.append(tokens[k])
json.dump(todo, open(lab / "reps2.json", "w"))
json.dump(prop, open(lab / "prop2.json", "w"))

docs = {}
CW, CH, COLS, ROWS = 250, 76, 6, 12
for si in range(0, len(todo), COLS * ROWS):
    sheet = Image.new("RGB", (CW * COLS, CH * ROWS), "white")
    d = ImageDraw.Draw(sheet)
    for j, i in enumerate(todo[si:si + COLS * ROWS]):
        c = clusters[i]
        cx, cy = (j % COLS) * CW, (j // COLS) * CH
        sheet.paste(render(c["polys"], 56).convert("RGB"), (cx + 34, cy + 10))
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
        d.text((cx + 2, cy + 56), prop[j + si], fill=(220, 0, 0))
        d.rectangle([cx, cy, cx + CW - 1, cy + CH - 1], outline=(190, 190, 190))
    sheet.save(lab / f"label2_{si // (COLS * ROWS):02d}.png")
print(len(todo), "to review", file=sys.stderr)
