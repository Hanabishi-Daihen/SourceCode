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

from .glyphs import descriptor
from .strokes import Atom, build_atoms, extract_strokes

DATA = Path(__file__).resolve().parent / "data" / "glyphs.json"
MIN_SCORE = 0.80
MAX_GLYPH = 10.0  # pt; anything larger is drawing geometry, not text
DOT = 0.35  # pt; atoms smaller than this in both directions are dots
NEUTRAL = {"|", "-", "/", "X", "x", "+", "."}


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

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def cy(self):
        return (self.y0 + self.y1) / 2

    def char_box(self, i: int, j: int):
        """Bounding box (display coords) of characters i..j-1 of ``text`` (spaces skipped)."""
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

    def classify(self, atom: Atom):
        polys = [[(x - atom.x0, y - atom.y0) for x, y in s.pts] for s in atom.strokes]
        v, _, _, a = descriptor(polys)
        sims = self.V @ v - 0.5 * np.abs(self.logA - np.log(a))
        k = int(np.argmax(sims))
        return self.ch[k], self.rot[k], float(sims[k])


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


def classify_page(page: pymupdf.Page, lib: TemplateLibrary | None = None) -> list[Glyph]:
    lib = lib or library()
    glyphs = []
    for at in build_atoms(extract_strokes(page), 12):
        if at.w <= DOT and at.h <= DOT:
            glyphs.append(Glyph(at, ".", 0, 1.0, at.x0, at.y0, at.x1, at.y1))
            continue
        if max(at.w, at.h) > MAX_GLYPH or len(at.strokes) > 25:
            continue
        ch, rot, sc = lib.classify(at)
        if ch is None or sc < MIN_SCORE:
            continue
        glyphs.append(Glyph(at, ch, rot, sc, at.x0, at.y0, at.x1, at.y1))
    return glyphs


def _lines_for(glyphs: list[Glyph], rot: int, taken: set[int]) -> list[tuple[list[int], float]]:
    """Group glyphs of one reading direction into lines.  Returns (indices, height)."""
    seeds = [i for i, g in enumerate(glyphs) if i not in taken and g.rot == rot and g.ch not in NEUTRAL]
    if not seeds:
        return []
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
        hs = sorted(fb[i][3] - fb[i][1] for i in members)
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
    out, prev_u1, gl = [], None, []
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
        if prev_u1 is not None and u0 - prev_u1 > 0.55 * H:
            out.append(" ")
        out.append(ch)
        gl.append(g)
        prev_u1 = u1 if prev_u1 is None else max(prev_u1, u1)
    text = "".join(out)
    text = _fix_bars(text)
    x0 = min(glyphs[i].x0 for i in members)
    y0 = min(glyphs[i].y0 for i in members)
    x1 = max(glyphs[i].x1 for i in members)
    y1 = max(glyphs[i].y1 for i in members)
    return TextLine(text, rot, x0, y0, x1, y1, H, gl)


def _fix_bars(text: str) -> str:
    """'|' is '1' next to digits and 'I' next to letters."""
    chars = list(text)
    for k, ch in enumerate(chars):
        if ch != "|":
            continue
        nb = [c for c in (chars[k - 1] if k else "", chars[k + 1] if k + 1 < len(chars) else "") if c and c not in " |"]
        if any(c.isdigit() or c in "./" for c in nb) or not nb:
            chars[k] = "1"
        else:
            chars[k] = "I"
    return "".join(chars)


def read_page(page: pymupdf.Page, lib: TemplateLibrary | None = None) -> list[TextLine]:
    glyphs = classify_page(page, lib)
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
    """Join single-character lines produced by neutral leftovers into neighbours."""
    return [ln for ln in lines if ln.text.strip()]
