"""Render a page region with atom bounding boxes overlaid (debug aid)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pymupdf
from PIL import Image, ImageDraw

from schcheck.strokes import extract_strokes, build_atoms

pdf, pno, x0, y0, x1, y1, out = sys.argv[1], int(sys.argv[2]), *map(float, sys.argv[3:7]), sys.argv[7]
zoom = float(sys.argv[8]) if len(sys.argv) > 8 else 8
doc = pymupdf.open(pdf)
page = doc[pno - 1]
clip = pymupdf.Rect(x0, y0, x1, y1)
pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip)
img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
dr = ImageDraw.Draw(img)
for a in build_atoms(extract_strokes(page), 12):
    if a.x1 < x0 or a.x0 > x1 or a.y1 < y0 or a.y0 > y1:
        continue
    dr.rectangle([(a.x0 - x0) * zoom, (a.y0 - y0) * zoom, (a.x1 - x0) * zoom, (a.y1 - y0) * zoom], outline=(255, 0, 0))
img.save(out)
