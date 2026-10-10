"""Read SHX stroke text from a PDF page.

Pipeline: strokes -> atoms (connected strokes) -> glyph classification against the
template library -> text lines assembled per reading direction.

Reading directions (``rot``):
  0  normal, left-to-right
  1  vertical, reading bottom-to-top (glyphs rotated 90deg CCW)
  3  vertical, reading top-to-bottom (glyphs rotated 90deg CW)
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pymupdf

from .glyphs import descriptor, rotate_upright
from .strokes import Atom, build_atoms, extract_strokes

DATA = Path(__file__).resolve().parent / "data" / "glyphs.json"
MIN_SCORE = 0.80
MAX_GLYPH = 10.0  # pt; anything larger is drawing geometry, not text
DOT = 0.35  # pt; atoms smaller than this in both directions are dots
NEUTRAL = {"|", "-", "/", "X", "x", "+", "."}
BRIDGE = {"X", "x", "+"}


@dataclass
class Glyph:
    atom: Atom | None
    ch: str
    rot: int
    score: float
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass
class TextLine:
    text: str
    rot: int
    x0: float
    y0: float
    x1: float
    y1: float
    height: float
    glyphs: list[Glyph] = field(default_factory=list)
    boxes: list = field(default_factory=list)  # device symbol boxes this text labels

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def cy(self):
        return (self.y0 + self.y1) / 2

    def char_box(self, i: int, j: int):
        """Bounding box (display coords) of characters i..j-1 of ``text`` (spaces skipped)."""
        if not self.glyphs:
            return (self.x0, self.y0, self.x1, self.y1)
        gs = [g for g in self._char_glyphs()[i:j] if g is not None]
        if not gs:
            return (self.x0, self.y0, self.x1, self.y1)
        return (min(g.x0 for g in gs), min(g.y0 for g in gs), max(g.x1 for g in gs), max(g.y1 for g in gs))

    def _char_glyphs(self):
        out, k = [], 0
        for ch in self.text:
            if ch == " ":
                out.append(None)
            else:
                out.append(self.glyphs[k])
                k += 1
        return out


class TemplateLibrary:
    def __init__(self, path: Path = DATA):
        entries = json.loads(Path(path).read_text())
        vs, asps, self.ch, self.rot = [], [], [], []
        for e in entries:
            v, _, _, a = descriptor(e["polys"])
            vs.append(v)
            asps.append(a)
            self.ch.append(e["ch"])
            self.rot.append(e["rot"])
        self.V = np.stack(vs)
        self.logA = np.log(np.array(asps))
        self._drop_conflicting_junk()

    def _drop_conflicting_junk(self, thr: float = 0.92):
        """Junk templates that look just like a character would swallow that character."""
        text = [i for i, c in enumerate(self.ch) if c is not None]
        T, TA = self.V[text], self.logA[text]
        keep = []
        for i, c in enumerate(self.ch):
            if c is None:
                s = T @ self.V[i] - 0.5 * np.abs(TA - self.logA[i])
                if s.max() >= thr:
                    continue
            keep.append(i)
        self.V, self.logA = self.V[keep], self.logA[keep]
        self.ch = [self.ch[i] for i in keep]
        self.rot = [self.rot[i] for i in keep]

    def classify(self, atom: Atom):
        return self.classify_many([atom])[0]

    def classify_many(self, atoms: list[Atom]):
        """Best template for each atom: (char or None, rot, score)."""
        if not atoms:
            return []
        polys_l = [[[(x - at.x0, y - at.y0) for x, y in s.pts] for s in at.strokes] for at in atoms]
        descs = [descriptor(p) for p in polys_l]
        Q = np.stack([d[0] for d in descs])
        la = np.log(np.array([d[3] for d in descs]))
        sims = Q @ self.V.T - 0.5 * np.abs(self.logA[None, :] - la[:, None])
        best = np.argmax(sims, axis=1)
        out = []
        for i, k in enumerate(best):
            ch, rot = self.ch[k], self.rot[k]
            if ch in ("P", "R"):
                ch = _p_or_r(polys_l[i], rot)
            out.append((ch, rot, float(sims[i, k])))
        return out


def _p_or_r(polys, rot: int) -> str:
    """P and R differ only by R's leg reaching the bottom-right corner."""
    up = rotate_upright(polys, rot)
    xs = [p[0] for pl in up for p in pl]
    ys = [p[1] for pl in up for p in pl]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    w, h = max(x1 - x0, 1e-6), max(y1 - y0, 1e-6)
    for pl in up:
        for (ax, ay), (bx, by) in zip(pl, pl[1:] or pl):
            for t in (0.0, 0.5, 1.0):
                px, py = ax + (bx - ax) * t, ay + (by - ay) * t
                if (px - x0) / w > 0.55 and (py - y0) / h > 0.85:
                    return "R"
    return "P"


_LIB: TemplateLibrary | None = None


def library() -> TemplateLibrary:
    global _LIB
    if _LIB is None:
        _LIB = TemplateLibrary()
    return _LIB


# --- reading frames --------------------------------------------------------
# u: position along the reading direction, v: position across it (downwards in
# the text's own frame).  A glyph's frame box is (u0, v0, u1, v1).

def _frame(g: Glyph, rot: int):
    if rot == 0:
        return g.x0, g.y0, g.x1, g.y1
    if rot == 1:
        return -g.y1, g.x0, -g.y0, g.x1
    return g.y0, -g.x1, g.y1, -g.x0


def _neutral_char(ch: str, rot: int) -> str:
    """Bars swap meaning when the text runs vertically."""
    if rot == 0:
        return ch
    return {"|": "-", "-": "|"}.get(ch, ch)


def classify_page(page: pymupdf.Page, lib: TemplateLibrary | None = None, strokes=None) -> list[Glyph]:
    lib = lib or library()
    glyphs = []
    if strokes is None:
        strokes = extract_strokes(page)
    cands = []
    for at in build_atoms(strokes, 12):
        if at.w <= DOT and at.h <= DOT:
            glyphs.append(Glyph(at, ".", 0, 1.0, at.x0, at.y0, at.x1, at.y1))
            continue
        if max(at.w, at.h) > MAX_GLYPH or len(at.strokes) > 25:
            continue
        cands.append(at)
    for at, (ch, rot, sc) in zip(cands, lib.classify_many(cands)):
        if ch is None or sc < MIN_SCORE:
            continue
        glyphs.append(Glyph(at, ch, rot, sc, at.x0, at.y0, at.x1, at.y1))
    return glyphs


def _lines_for(glyphs: list[Glyph], rot: int, taken: set[int]) -> list[tuple[list[int], float]]:
    """Group glyphs of one reading direction into lines.  Returns (indices, height)."""
    core = {i for i, g in enumerate(glyphs) if i not in taken and g.rot == rot and g.ch not in NEUTRAL}
    if not core:
        return []
    # symmetric characters may bridge two parts of a line, but never start one on their own
    bridges = {i for i, g in enumerate(glyphs) if i not in taken and g.ch in BRIDGE and g.rot in (0, rot)}
    seeds = list(core | bridges)
    fb = {i: _frame(glyphs[i], rot) for i in range(len(glyphs))}
    parent = {i: i for i in seeds}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    seeds.sort(key=lambda i: fb[i][0])
    for a_i, a in enumerate(seeds):
        au0, av0, au1, av1 = fb[a]
        ha = av1 - av0
        for b in seeds[a_i + 1:]:
            bu0, bv0, bu1, bv1 = fb[b]
            hb = bv1 - bv0
            h = max(ha, hb)
            if bu0 - au1 > 1.2 * h:
                break
            if min(ha, hb) < 0.55 * h:
                continue
            ov = min(av1, bv1) - max(av0, bv0)
            if ov < 0.6 * min(ha, hb):
                continue
            parent[find(a)] = find(b)
    groups: dict[int, list[int]] = {}
    for i in seeds:
        groups.setdefault(find(i), []).append(i)

    lines = []
    for members in groups.values():
        if not any(i in core for i in members):
            continue
        hs = sorted(fb[i][3] - fb[i][1] for i in members if i in core)
        H = hs[len(hs) // 2]
        lines.append((members, H))
    return lines


def _attach_neutrals(glyphs, lines, rot, taken):
    """Attach bars, dots, slashes etc. to existing lines of this direction."""
    fb = {i: _frame(glyphs[i], rot) for i in range(len(glyphs))}
    for members, H in lines:
        u0 = min(fb[i][0] for i in members)
        u1 = max(fb[i][2] for i in members)
        v0 = min(fb[i][1] for i in members)
        v1 = max(fb[i][3] for i in members)
        changed = True
        while changed:
            changed = False
            for i, g in enumerate(glyphs):
                if i in taken or g.ch not in NEUTRAL or i in members:
                    continue
                gu0, gv0, gu1, gv1 = fb[i]
                if gu1 < u0 - 1.0 * H or gu0 > u1 + 1.0 * H:
                    continue
                if gv1 - gv0 > 1.25 * H or gv0 < v0 - 0.25 * H or gv1 > v1 + 0.25 * H:
                    continue
                if gu1 - gu0 > 1.5 * H:
                    continue
                members.append(i)
                taken.add(i)
                u0, u1 = min(u0, gu0), max(u1, gu1)
                changed = True


def _line_text(glyphs, members, H, rot):
    fb = {i: _frame(glyphs[i], rot) for i in members}
    members.sort(key=lambda i: (fb[i][0] + fb[i][2]) / 2)
    vs = [fb[i] for i in members if glyphs[i].ch not in NEUTRAL]
    base = sorted(v[3] for v in vs)[len(vs) // 2] if vs else max(fb[i][3] for i in members)
    top = sorted(v[1] for v in vs)[len(vs) // 2] if vs else min(fb[i][1] for i in members)
    out, prev_u1, prev_w, gl = [], None, None, []
    for i in members:
        g = glyphs[i]
        u0, v0, u1, v1 = fb[i]
        ch = _neutral_char(g.ch, rot) if g.rot != rot or g.ch in NEUTRAL else g.ch
        # bars: decide '-', '_', '|' from geometry in the reading frame
        w, h = u1 - u0, v1 - v0
        if ch in ("|", "-", "/") and w < 0.3 * H and h < 0.3 * H:
            ch = "."
        if ch in ("|", "-"):
            if h >= 0.6 * H and w < 0.3 * H:
                ch = "|"
            elif h < 0.25 * H:
                mid = (v0 + v1) / 2
                ch = "_" if mid > base - 0.15 * H else "-"
        if ch == "." and (v0 + v1) / 2 < top + 0.6 * (base - top):
            ch = "·"  # mid-height dot (e.g. a junction or a multiplication sign)
        if prev_u1 is not None:
            # narrow glyphs such as '1' sit centred in a wider cell: discount that slack
            slack = 0.5 * max(0.0, 0.5 * H - w) + 0.5 * max(0.0, 0.5 * H - prev_w)
            if u0 - prev_u1 - slack > 0.55 * H:
                out.append(" ")
        out.append(ch)
        gl.append(g)
        prev_u1 = u1 if prev_u1 is None else max(prev_u1, u1)
        prev_w = w
    text = "".join(out)
    text = _fix_bars(text)
    x0 = min(glyphs[i].x0 for i in members)
    y0 = min(glyphs[i].y0 for i in members)
    x1 = max(glyphs[i].x1 for i in members)
    y1 = max(glyphs[i].y1 for i in members)
    return TextLine(text, rot, x0, y0, x1, y1, H, gl)


def _fix_bars(text: str) -> str:
    """A bare vertical bar is '1' among digits and 'I' before letters."""
    chars = list(text)
    for k, ch in enumerate(chars):
        if ch != "|":
            continue
        prev = chars[k - 1] if k else ""
        nxt = chars[k + 1] if k + 1 < len(chars) else ""
        if nxt.isalpha() and nxt not in "|":
            chars[k] = "I"
        elif prev.isalpha() and not nxt.isdigit() and nxt not in "./" and prev not in "|":
            chars[k] = "I"
        else:
            chars[k] = "1"
    return "".join(chars)


def read_page(page: pymupdf.Page, lib: TemplateLibrary | None = None, strokes=None) -> list[TextLine]:
    glyphs = classify_page(page, lib, strokes)
    taken: set[int] = set()
    all_lines = []
    for rot in (0, 1, 3):
        lines = _lines_for(glyphs, rot, taken)
        for members, _ in lines:
            taken.update(members)
        _attach_neutrals(glyphs, lines, rot, taken)
        all_lines.extend((m, H, rot) for m, H in lines)
    # leftover neutral glyphs that form text on their own (e.g. "11", "1-1")
    rest = [i for i, g in enumerate(glyphs) if i not in taken and g.ch in ("|", "-", "/", "X", "+")]
    for i in rest:
        g = glyphs[i]
        if g.ch == "|" and 1.2 <= g.y1 - g.y0 <= MAX_GLYPH:
            all_lines.append(([i], g.y1 - g.y0, 0))
            taken.add(i)
    out = [_line_text(glyphs, m, H, rot) for m, H, rot in all_lines]
    return _merge_split_lines(out)


def _merge_split_lines(lines: list[TextLine]) -> list[TextLine]:
    """Re-join cross-references split at the slash ('2 /' + '05.E1' -> '2 /05.E1')."""
    lines = [ln for ln in lines if ln.text.strip()]
    used = set()
    out = []
    for a in lines:
        if id(a) in used:
            continue
        cur = a
        while cur.text.rstrip().endswith("/"):
            nxt = None
            for b in lines:
                if b is cur or id(b) in used or b.rot != cur.rot or not b.text[:1].isdigit():
                    continue
                if cur.rot == 0:
                    gap, dv = b.x0 - cur.x1, abs(b.cy - cur.cy)
                elif cur.rot == 1:
                    gap, dv = cur.y0 - b.y1, abs(b.cx - cur.cx)
                else:
                    gap, dv = b.y0 - cur.y1, abs(b.cx - cur.cx)
                if -0.2 * cur.height < gap < 1.5 * cur.height and dv < 0.35 * cur.height:
                    nxt = b
                    break
            if nxt is None:
                break
            used.add(id(nxt))
            cur = TextLine(cur.text.rstrip() + nxt.text, cur.rot, min(cur.x0, nxt.x0), min(cur.y0, nxt.y0),
                           max(cur.x1, nxt.x1), max(cur.y1, nxt.y1), cur.height, cur.glyphs + nxt.glyphs)
        out.append(cur)
    return out
