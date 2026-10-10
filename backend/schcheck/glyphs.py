"""Shape descriptor for stroke atoms, used to match them against glyph templates."""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

from .strokes import Atom

RES = 24  # raster resolution of the descriptor
PAD = 2


def atom_polylines(atom: Atom, rot: int = 0) -> list[list[tuple[float, float]]]:
    """Polylines of the atom relative to its bbox, rotated by rot*90deg CW for reading.

    rot=0: upright text.  rot=1: text reading bottom-to-top (rotated 90deg CCW on the
    sheet); rotating its points 90deg CW makes it upright.
    """
    out = []
    for s in atom.strokes:
        pts = [(x - atom.x0, y - atom.y0) for x, y in s.pts]
        if rot == 1:
            # 90deg CW in display coords (y down): (x, y) -> (h - y, x)
            h = atom.h
            pts = [(h - y, x) for x, y in pts]
        out.append(pts)
    return out


def rotate_upright(polys, rot: int):
    """Rotate polylines of a vertical glyph back to upright.

    rot=1: glyph was rotated 90deg CCW on the sheet (text reads bottom-to-top).
    rot=3: glyph was rotated 90deg CW (text reads top-to-bottom).
    Coordinates are display coordinates (y down).
    """
    if rot == 0:
        return polys
    xs = [p[0] for pl in polys for p in pl]
    ys = [p[1] for pl in polys for p in pl]
    if rot == 1:
        h = max(ys)
        return [[(h - y, x) for x, y in pl] for pl in polys]
    if rot == 3:
        w = max(xs)
        return [[(y, w - x) for x, y in pl] for pl in polys]
    w, h = max(xs), max(ys)
    return [[(w - x, h - y) for x, y in pl] for pl in polys]


def descriptor(polys: list[list[tuple[float, float]]]) -> tuple[np.ndarray, float, float, float]:
    """Return (raster vector, width, height, aspect) for polylines already at the origin."""
    xs = [p[0] for pl in polys for p in pl]
    ys = [p[1] for pl in polys for p in pl]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    mx, my = min(xs), min(ys)
    s = max(w, h, 1e-6)
    inner = RES - 2 * PAD
    ox = PAD + (inner - w / s * inner) / 2
    oy = PAD + (inner - h / s * inner) / 2
    img = Image.new("L", (RES, RES), 0)
    dr = ImageDraw.Draw(img)
    for pl in polys:
        pts = [(ox + (x - mx) / s * inner, oy + (y - my) / s * inner) for x, y in pl]
        if len(pts) == 1 or all(abs(p[0] - pts[0][0]) < 0.3 and abs(p[1] - pts[0][1]) < 0.3 for p in pts):
            dr.ellipse([pts[0][0] - 1, pts[0][1] - 1, pts[0][0] + 1, pts[0][1] + 1], fill=255)
        else:
            dr.line(pts, fill=255, width=2)
    a = np.asarray(img, dtype=np.float32) / 255.0
    # small blur for tolerance against quantisation of the plotter coordinates
    b = a.copy()
    b[1:, :] += a[:-1, :] * 0.5
    b[:-1, :] += a[1:, :] * 0.5
    b[:, 1:] += a[:, :-1] * 0.5
    b[:, :-1] += a[:, 1:] * 0.5
    v = b.ravel()
    n = np.linalg.norm(v)
    if n > 0:
        v = v / n
    aspect = (w + 0.05 * s) / (h + 0.05 * s)
    return v, w, h, aspect


def similarity(v1, asp1, v2, asp2) -> float:
    """Cosine similarity of rasters, penalised by aspect-ratio mismatch."""
    cos = float(np.dot(v1, v2))
    ar = abs(np.log(asp1 / asp2))
    return cos - 0.5 * ar
