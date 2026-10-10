"""Extract stroke polylines from a PDF page and group them into connected atoms.

AutoCAD plots SHX text as plain line strokes, so every character on a sheet is
just a handful of short polylines mixed in with the wiring.  This module pulls
all polylines out (in display coordinates, i.e. after page rotation) and joins
strokes that touch into "atoms" — usually one atom per character.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import math

import pymupdf


@dataclass
class Stroke:
    pts: list[tuple[float, float]]
    x0: float = 0.0
    y0: float = 0.0
    x1: float = 0.0
    y1: float = 0.0

    def __post_init__(self):
        xs = [p[0] for p in self.pts]
        ys = [p[1] for p in self.pts]
        self.x0, self.x1, self.y0, self.y1 = min(xs), max(xs), min(ys), max(ys)

    @property
    def size(self) -> float:
        return max(self.x1 - self.x0, self.y1 - self.y0)

    def segments(self):
        return zip(self.pts, self.pts[1:]) if len(self.pts) > 1 else [(self.pts[0], self.pts[0])]


@dataclass
class Atom:
    strokes: list[Stroke] = field(default_factory=list)
    x0: float = math.inf
    y0: float = math.inf
    x1: float = -math.inf
    y1: float = -math.inf

    def add(self, s: Stroke):
        self.strokes.append(s)
        self.x0, self.y0 = min(self.x0, s.x0), min(self.y0, s.y0)
        self.x1, self.y1 = max(self.x1, s.x1), max(self.y1, s.y1)

    @property
    def w(self):
        return self.x1 - self.x0

    @property
    def h(self):
        return self.y1 - self.y0

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def cy(self):
        return (self.y0 + self.y1) / 2


def extract_strokes(page: pymupdf.Page) -> list[Stroke]:
    """All stroked polylines on the page in rotated (display) coordinates."""
    m = page.rotation_matrix
    a, b, c, d, e, f = m.a, m.b, m.c, m.d, m.e, m.f

    def tf(p):
        x, y = p.x, p.y
        return (round(a * x + c * y + e, 3), round(b * x + d * y + f, 3))

    out: list[Stroke] = []
    for dr in page.get_drawings():
        if dr.get("type") not in ("s", "fs"):
            continue
        cur: list[tuple[float, float]] = []
        for it in dr["items"]:
            kind = it[0]
            if kind == "l" or kind == "c":
                pa, pb = tf(it[1]), tf(it[2] if kind == "l" else it[4])
                if cur and _close(cur[-1], pa):
                    cur.append(pb)
                else:
                    if cur:
                        out.append(Stroke(cur))
                    cur = [pa, pb]
            elif kind == "re":
                r = it[1]
                if cur:
                    out.append(Stroke(cur))
                    cur = []
                pts = [tf(r.tl), tf(r.tr), tf(r.br), tf(r.bl)]
                out.append(Stroke(pts + [pts[0]]))
            elif kind == "qu":
                q = it[1]
                if cur:
                    out.append(Stroke(cur))
                    cur = []
                pts = [tf(q.ul), tf(q.ur), tf(q.lr), tf(q.ll)]
                out.append(Stroke(pts + [pts[0]]))
            else:
                if cur:
                    out.append(Stroke(cur))
                    cur = []
        if cur:
            out.append(Stroke(cur))
    return out


def _close(a, b, tol=1e-3):
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol


def _seg_dist(p, q, r, s) -> float:
    """Minimum distance between segments pq and rs."""
    if _seg_intersect(p, q, r, s):
        return 0.0
    return min(_pt_seg(p, r, s), _pt_seg(q, r, s), _pt_seg(r, p, q), _pt_seg(s, p, q))


def _pt_seg(p, a, b) -> float:
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    if L == 0:
        return math.hypot(p[0] - ax, p[1] - ay)
    t = max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L))
    return math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy)


def _orient(a, b, c):
    v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    return 0 if abs(v) < 1e-9 else (1 if v > 0 else -1)


def _seg_intersect(p, q, r, s) -> bool:
    o1, o2, o3, o4 = _orient(p, q, r), _orient(p, q, s), _orient(r, s, p), _orient(r, s, q)
    return o1 != o2 and o3 != o4 and 0 not in (o1, o2, o3, o4)


def strokes_touch(a: Stroke, b: Stroke, tol: float) -> bool:
    if a.x0 - tol > b.x1 or b.x0 - tol > a.x1 or a.y0 - tol > b.y1 or b.y0 - tol > a.y1:
        return False
    for p, q in a.segments():
        for r, s in b.segments():
            if _seg_dist(p, q, r, s) <= tol:
                return True
    return False


def build_atoms(strokes: list[Stroke], max_size: float, tol: float = 0.3) -> list[Atom]:
    """Union touching small strokes into atoms (connected components)."""
    small = [s for s in strokes if s.size <= max_size]
    n = len(small)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    cell = max(max_size, 1.0)
    pad = max(tol, 0.5)
    grid: dict[tuple[int, int], list[int]] = {}
    for i, s in enumerate(small):
        for gx in range(int((s.x0 - pad) // cell), int((s.x1 + pad) // cell) + 1):
            for gy in range(int((s.y0 - pad) // cell), int((s.y1 + pad) // cell) + 1):
                grid.setdefault((gx, gy), []).append(i)
    pairs = set()
    for idxs in grid.values():
        for a_i in range(len(idxs)):
            for b_i in range(a_i + 1, len(idxs)):
                i, j = idxs[a_i], idxs[b_i]
                pairs.add((i, j) if i < j else (j, i))
    pairs = sorted(pairs)
    for i, j in pairs:
        if find(i) != find(j) and strokes_touch(small[i], small[j], tol):
            parent[find(i)] = find(j)
    # second pass: larger text has proportionally larger gaps between its strokes,
    # so allow a gap relative to the size of the groups formed so far
    box: dict[int, list[float]] = {}
    for i, s in enumerate(small):
        r = find(i)
        b = box.setdefault(r, [s.x0, s.y0, s.x1, s.y1])
        b[0], b[1], b[2], b[3] = min(b[0], s.x0), min(b[1], s.y0), max(b[2], s.x1), max(b[3], s.y1)
    gsize = {r: max(b[2] - b[0], b[3] - b[1]) for r, b in box.items()}
    for i, j in pairs:
        ri, rj = find(i), find(j)
        if ri == rj:
            continue
        t = min(0.6, 0.075 * max(gsize.get(ri, 0), gsize.get(rj, 0)))
        if t > tol and strokes_touch(small[i], small[j], t):
            parent[ri] = rj
    groups: dict[int, Atom] = {}
    for i, s in enumerate(small):
        groups.setdefault(find(i), Atom()).add(s)
    return list(groups.values())
