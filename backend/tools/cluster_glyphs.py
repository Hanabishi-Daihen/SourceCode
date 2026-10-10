"""Cluster stroke atoms across PDFs into unique glyph shapes.

usage: cluster_glyphs.py OUT.json PDF:PAGES [PDF:PAGES ...]   (PAGES like 1-25)
Each cluster stores the representative's normalised polylines plus where it was seen.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import pymupdf

from schcheck.strokes import extract_strokes, build_atoms
from schcheck.glyphs import atom_polylines, descriptor

THR = 0.9
MAXN = 200000
V = np.zeros((MAXN, 576), dtype=np.float32)
A = np.zeros(MAXN, dtype=np.float32)
K = 0
clusters = []
for spec in sys.argv[2:]:
    pdf, rng = spec.rsplit(":", 1)
    a, b = map(int, rng.split("-"))
    doc = pymupdf.open(pdf)
    for pno in range(a, b + 1):
        atoms = build_atoms(extract_strokes(doc[pno - 1]), 12)
        for at in atoms:
            if (at.w < 0.3 and at.h < 0.3) or max(at.w, at.h) > 10 or len(at.strokes) > 25:
                continue
            polys = atom_polylines(at)
            v, w, h, asp = descriptor(polys)
            if K:
                sims = V[:K] @ v - 0.5 * np.abs(np.log(A[:K] / asp))
                k = int(np.argmax(sims))
                if sims[k] >= THR:
                    clusters[k]["n"] += 1
                    continue
            V[K], A[K] = v, asp
            K += 1
            clusters.append({"n": 1, "pdf": pdf, "page": pno, "bbox": [at.x0, at.y0, at.x1, at.y1],
                             "polys": [[[round(x, 3), round(y, 3)] for x, y in pl] for pl in polys]})
        print(pdf, pno, K, file=sys.stderr)
json.dump(clusters, open(sys.argv[1], "w"))
print(K, "clusters", file=sys.stderr)
