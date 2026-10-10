"""Page model: sheet number, zone grid and the elements the checker needs."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import pymupdf

from .ocr import TextLine, read_page
from .strokes import extract_strokes

XREF = re.compile(r"/(\d{1,3})\.([A-L])(\d{1,2})")
TAG = re.compile(r"-([0-9]*[A-Z][A-Z0-9]*)")
DIGITS = re.compile(r"^\d{1,3}$")
# words that appear after a dash in switch labels ("ON-OFF") but are not device tags
NOT_TAGS = {"ON", "OFF", "AUTO", "MAN", "MANUAL", "TEST", "RESET", "LOCAL", "REMOTE", "RAISE", "LOWER",
            "STOP", "START", "OPEN", "CLOSE", "TRIP", "ALARM", "SPARE", "GND", "PE"}


@dataclass
class Zone:
    sheet: int | None
    row: str
    col: int

    def __str__(self):
        return f"{self.sheet if self.sheet is not None else '?'}.{self.row}{self.col}"


@dataclass
class Grid:
    cols: list[tuple[int, float]]  # (label, centre x)
    rows: list[tuple[str, float]]  # (label, centre y)
    col_ticks: list[float] = field(default_factory=list)  # zone boundaries from the border ticks
    row_ticks: list[float] = field(default_factory=list)

    def zone(self, x: float, y: float) -> tuple[str, int] | None:
        if not self.cols or not self.rows:
            return None
        return _cell(self.rows, self.row_ticks, y), _cell(self.cols, self.col_ticks, x)

    def zones(self, box) -> set[tuple[str, int]]:
        """All zones a rectangle touches (slightly shrunk so a hairline overlap does not count)."""
        x0, y0, x1, y1 = box
        dx, dy = min(0.5, (x1 - x0) / 4), min(0.5, (y1 - y0) / 4)
        out = set()
        for x in (x0 + dx, (x0 + x1) / 2, x1 - dx):
            for y in (y0 + dy, (y0 + y1) / 2, y1 - dy):
                z = self.zone(x, y)
                if z:
                    out.add(z)
        return out


def _cell(cells, ticks, v):
    """Label of the cell containing v: between border ticks when known, else midpoints."""
    if ticks:
        k = sum(1 for t in ticks if t <= v)  # number of boundaries left of v
        # ticks separate consecutive cells; find the cell whose centre lies in the same gap
        for lab, c in cells:
            if sum(1 for t in ticks if t <= c) == k:
                return lab
    best = cells[0][0]
    for k, (lab, c) in enumerate(cells):
        lo = (cells[k - 1][1] + c) / 2 if k else float("-inf")
        hi = (c + cells[k + 1][1]) / 2 if k + 1 < len(cells) else float("inf")
        if lo <= v < hi:
            return lab
    return best


@dataclass
class XRef:
    sheet: int
    row: str
    col: int
    line: TextLine
    bbox: tuple[float, float, float, float]

    def __str__(self):
        return f"/{self.sheet:02d}.{self.row}{self.col}"

    def same_zone(self, z: Zone) -> bool:
        return self.sheet == z.sheet and self.row == z.row and self.col == z.col

    def in_zones(self, sheet: int | None, zones: set) -> bool:
        return self.sheet == sheet and (self.row, self.col) in zones


@dataclass
class TableRow:
    terminals: tuple[str, ...]
    xref: XRef


@dataclass
class Coil:
    tag: str
    page: int
    line: TextLine
    anchor: tuple[float, float]
    zone: Zone
    rows: list[TableRow] = field(default_factory=list)
    zones: set = field(default_factory=set)  # every zone the coil symbol touches


@dataclass
class Contact:
    tag: str
    page: int
    line: TextLine
    backref: XRef | None
    anchor: tuple[float, float]
    zone: Zone
    terminals: tuple[str, ...] = ()
    zones: set = field(default_factory=set)  # every zone the contact symbol touches


@dataclass
class BomRow:
    page: int
    designations: list[str]
    sheets: list[int]
    desig_lines: list[TextLine]
    sheet_lines: list[TextLine]


@dataclass
class PageInfo:
    index: int  # 0-based PDF page index
    width: float
    height: float
    sheet: int | None
    series: str | None
    kind: str  # 'bom' | 'schematic' | 'other'
    grid: Grid
    lines: list[TextLine]
    coils: list[Coil] = field(default_factory=list)
    contacts: list[Contact] = field(default_factory=list)
    bom_rows: list[BomRow] = field(default_factory=list)
    tags: dict[str, list[TextLine]] = field(default_factory=dict)
    tokens: dict[str, list[TextLine]] = field(default_factory=dict)  # loose device names (BOM check)

    def zone_of(self, x: float, y: float) -> Zone | None:
        z = self.grid.zone(x, y)
        return Zone(self.sheet, z[0], z[1]) if z else None


# --- page level ------------------------------------------------------------

def _ticks(strokes, w, h):
    """Short border ticks that separate the zone labels."""
    xs, ys = [], []
    for st in strokes:
        if len(st.pts) != 2:
            continue
        (ax, ay), (bx, by) = st.pts
        if abs(ax - bx) < 0.05 and 0.004 * h < abs(ay - by) < 0.04 * h and max(ay, by) < 0.07 * h:
            xs.append(ax)
        if abs(ay - by) < 0.05 and 0.004 * w < abs(ax - bx) < 0.04 * w and max(ax, bx) < 0.06 * w:
            ys.append(ay)
    return _dedupe(xs), _dedupe(ys)


def _dedupe(vals, tol=1.0):
    out = []
    for v in sorted(vals):
        if not out or v - out[-1] > tol:
            out.append(v)
    return out


def find_grid(lines: list[TextLine], w: float, h: float, strokes=None) -> Grid:
    cols: dict[int, list[float]] = {}
    for ln in lines:
        t = ln.text.strip()
        if ln.rot == 0 and DIGITS.match(t) and ln.cy < 0.06 * h:
            cols.setdefault(int(t), []).append(ln.cx)
    rows: dict[str, list[float]] = {}
    for ln in lines:
        t = ln.text.strip()
        if ln.rot == 0 and re.fullmatch(r"[A-L]", t) and (ln.cx < 0.05 * w or ln.cx > 0.95 * w):
            rows.setdefault(t, []).append(ln.cy)
    col_list = sorted(((k, sum(v) / len(v)) for k, v in cols.items() if 1 <= k <= 20), key=lambda c: c[1])
    row_list = sorted(((k, sum(v) / len(v)) for k, v in rows.items()), key=lambda r: r[1])
    col_list = _drop_outliers(_monotonic(col_list))
    row_list = _monotonic([(r, y) for r, y in row_list], key=lambda r: ord(r))
    row_list = [(chr(64 + k), y) for k, y in _drop_outliers([(ord(r) - 64, y) for r, y in row_list])]
    col_list = _fill(col_list, lambda l: l, lambda k: k, 0.97 * w)
    row_list = _fill(row_list, lambda l: ord(l) - 64, lambda k: chr(64 + k), 0.97 * h)
    cx, ry = _ticks(strokes or [], w, h)
    return Grid(col_list, row_list, _usable_ticks(cx, col_list), _usable_ticks(ry, row_list))


def _usable_ticks(ticks, cells):
    """Keep ticks only if they separate every pair of neighbouring labels exactly once."""
    if len(cells) < 2:
        return []
    keep = []
    for (_, a), (_, b) in zip(cells, cells[1:]):
        between = [t for t in ticks if a < t < b]
        if len(between) != 1:
            return []
        keep.append(between[0])
    return keep


def _monotonic(cells, key=lambda v: v):
    """Keep the longest run of labels that increase with position."""
    out = []
    for lab, c in cells:
        if not out or key(lab) > key(out[-1][0]):
            out.append((lab, c))
    return out if len(out) >= 3 else []


def _drop_outliers(cells):
    """Drop labels whose position breaks the regular spacing of the grid."""
    if len(cells) < 4:
        return cells
    steps = sorted((b[1] - a[1]) / (b[0] - a[0]) for a, b in zip(cells, cells[1:]))
    step = steps[len(steps) // 2]
    base = sorted(c - k * step for k, c in cells)[len(cells) // 2]
    return [(k, c) for k, c in cells if abs(c - (base + k * step)) < 0.25 * step]


def _fill(cells, idx, lab, limit):
    """Fill missing labels between/after known ones using the median spacing.

    idx: label -> integer position, lab: integer position -> label.
    """
    if len(cells) < 3:
        return cells
    known = {idx(l): c for l, c in cells}
    ks = sorted(known)
    steps = [(known[b] - known[a]) / (b - a) for a, b in zip(ks, ks[1:])]
    step = sorted(steps)[len(steps) // 2]
    out = dict(known)
    for k in range(ks[0], ks[-1] + 1):
        if k not in out:
            a = max(x for x in ks if x < k)
            out[k] = known[a] + (k - a) * step
    k = ks[0] - 1
    while k >= 1 and out[k + 1] - step > step * 0.4:
        out[k] = out[k + 1] - step
        k -= 1
    k = ks[-1] + 1
    while out[k - 1] + step < limit - step * 0.3 and k - ks[-1] <= 2:
        out[k] = out[k - 1] + step
        k += 1
    return [(lab(k), out[k]) for k in sorted(out)]


def find_sheet_number(lines: list[TextLine], w: float, h: float) -> int | None:
    labels = [ln for ln in lines if ln.text.replace(" ", "") == "SHEET" and ln.cx > 0.6 * w and ln.cy > 0.75 * h]
    if not labels:
        return None
    lab = max(labels, key=lambda ln: ln.cx + ln.cy)
    best = None
    for ln in lines:
        t = ln.text.replace(" ", "")
        if not t.isdigit() or ln is lab:
            continue
        if ln.y0 < lab.y1 - 0.2 * lab.height or ln.y0 > lab.y1 + 6 * lab.height:
            continue
        if ln.cx < lab.x0 - 3 * lab.height or ln.cx > lab.x1 + 3 * lab.height:
            continue
        d = ln.y0 - lab.y1
        if best is None or d < best[0]:
            best = (d, int(t))
    return best[1] if best else None


def find_drawing_number(lines: list[TextLine], w: float, h: float) -> tuple[str | None, int | None]:
    """Drawing number from the title block, e.g. 'CD-PP1005B-4S-16' -> ('CD-PP1005B-4S', 16)."""
    labels = [ln for ln in lines if ln.text.replace(" ", "").startswith("DRAWINGNO") and ln.cy > 0.75 * h]
    if not labels:
        return None, None
    lab = max(labels, key=lambda ln: ln.cy)
    H = lab.height
    right = min((ln.x0 for ln in lines if ln.text.replace(" ", "") == "DESCRIPTION" and abs(ln.cy - lab.cy) < H
                 and ln.x0 > lab.x1), default=lab.x1 + 60 * H)
    parts = [ln for ln in lines if ln.rot == 0 and 0 < ln.cy - lab.cy < 3 * H and lab.x0 - 3 * H < ln.cx < right]
    if not parts:
        return None, None
    row = min(parts, key=lambda ln: ln.cy).cy
    parts = sorted((ln for ln in parts if abs(ln.cy - row) < 0.6 * H), key=lambda ln: ln.x0)
    text = "".join(ln.text.replace(" ", "") for ln in parts)
    m = re.fullmatch(r"(.+?)-?(\d{1,3})", text)
    if not m:
        return text or None, None
    return m.group(1).rstrip("-"), int(m.group(2))


def real_text_lines(page: pymupdf.Page) -> list[TextLine]:
    """Text that the PDF stores as real text (TrueType fonts, vendor drawings)."""
    m = page.rotation_matrix
    o = pymupdf.Point(0, 0) * m
    out = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            text = "".join(sp["text"] for sp in line["spans"]).strip()
            if not text:
                continue
            r = pymupdf.Rect(line["bbox"]) * m
            d = pymupdf.Point(line["dir"]) * m - o
            if abs(d.x) >= abs(d.y):
                rot, height = (0, r.height) if d.x > 0 else (2, r.height)
            else:
                rot, height = (1, r.width) if d.y < 0 else (3, r.width)
            if rot == 2:
                continue
            # the line box includes ascent/descent; cap height is roughly 70% of it
            out.append(TextLine(text, rot, r.x0, r.y0, r.x1, r.y1, 0.7 * height, []))
    return out


def analyse_page(page: pymupdf.Page, index: int) -> PageInfo:
    strokes = extract_strokes(page)
    lines = read_page(page, strokes=strokes) + real_text_lines(page)
    w, h = page.rect.width, page.rect.height
    grid = find_grid(lines, w, h, strokes)
    sheet = find_sheet_number(lines, w, h)
    series, dwg_no = find_drawing_number(lines, w, h)
    if sheet is None:
        sheet = dwg_no
    real = page.get_text()
    texts = " ".join(ln.text for ln in lines)
    if ("DESIGNATION" in real or "DESIGNATION" in texts) and ("QTY" in real or "QTY" in texts):
        kind = "bom"
    elif grid.cols and grid.rows:
        kind = "schematic"
    else:
        kind = "other"
    info = PageInfo(index, w, h, sheet, series, kind, grid, lines)
    for ln in lines:
        for tok in _tokens(ln.text):
            info.tokens.setdefault(tok, []).append(ln)
    if kind == "bom":
        info.bom_rows = parse_bom(page, info, strokes)
    elif kind == "schematic":
        parse_schematic(info, strokes)
    return info


# --- schematic pages -------------------------------------------------------

def _xrefs(ln: TextLine) -> list[XRef]:
    out = []
    compact = ln.text.replace(" ", "")
    for m in XREF.finditer(compact):
        # map compact indices back to the text with spaces for char boxes
        i0, i1 = _uncompact(ln.text, m.start()), _uncompact(ln.text, m.end() - 1) + 1
        out.append(XRef(int(m.group(1)), m.group(2), int(m.group(3)), ln, ln.char_box(i0, i1)))
    return out


def _uncompact(text: str, k: int) -> int:
    n = -1
    for i, ch in enumerate(text):
        if ch != " ":
            n += 1
            if n == k:
                return i
    return len(text) - 1


def _tokens(text: str) -> set[str]:
    """Device-name-like tokens of a text line, with or without the leading '-'."""
    out = set(_tags_in(text))
    for tok in re.split(r"[\s,]+", text.upper()):
        tok = tok.strip("-+()")
        if not tok or tok.isdigit() or not re.search(r"[A-Z]", tok):
            continue
        out.add(tok)
        if "." in tok:
            out.add(tok.split(".")[0])  # terminal X3.26 -> strip X3
        if "/" in tok:
            out.add(tok.split("/")[0])
        if len(tok) > 2 and tok.endswith("E"):
            out.add(tok[:-1])  # push-button symbol 'E' written right after the tag
    return out


def _tags(ln: TextLine) -> list[str]:
    return _tags_in(ln.text)


def _tags_in(text: str) -> list[str]:
    # device tags are written in capitals; lower-case words ('hysteresis') are not tags
    t = text.replace(" ", "").replace("x", "X")
    out = []
    for m in TAG.finditer(t):
        if m.start() > 0 and t[m.start() - 1].isalnum():
            continue
        tag = m.group(1)
        end = m.end()
        if end < len(t) and t[end] == ".":
            continue  # terminal reference such as -X3.26
        if tag.isdigit() or len(tag) < 2 or tag in NOT_TAGS:
            continue
        out.append(tag)
    return out


def _overlap(a0, a1, b0, b1):
    return min(a1, b1) - max(a0, b0)


def _boxes(strokes, text_atoms):
    """Axis-aligned closed rectangles drawn as one polyline (coil symbols)."""
    out = []
    for s in strokes:
        if len(s.pts) not in (5, 4):
            continue
        p = s.pts
        if len(p) == 5 and (abs(p[0][0] - p[-1][0]) > 0.05 or abs(p[0][1] - p[-1][1]) > 0.05):
            continue
        xs = sorted({round(q[0], 1) for q in p})
        ys = sorted({round(q[1], 1) for q in p})
        if len(xs) != 2 or len(ys) != 2:
            continue
        wd, ht = xs[1] - xs[0], ys[1] - ys[0]
        if 1.5 < wd < 300 and 1.5 < ht < 200:
            out.append((xs[0], ys[0], xs[1], ys[1]))
    return _merge_touching(out)


def _merge_touching(boxes, tol=0.6):
    """Coils such as latching relays are drawn as several adjoining boxes; treat them as one."""
    boxes = list(boxes)
    merged = True
    while merged:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if a[0] - tol <= b[2] and b[0] - tol <= a[2] and a[1] - tol <= b[3] and b[1] - tol <= a[3]:
                    # only merge side-by-side boxes of similar height (not nested or stacked frames)
                    if abs((a[3] - a[1]) - (b[3] - b[1])) < 0.35 * max(a[3] - a[1], b[3] - b[1]):
                        boxes[i] = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
                        boxes.pop(j)
                        merged = True
                        break
            if merged:
                break
    return boxes


def parse_schematic(info: PageInfo, strokes):
    lines = info.lines
    text_strokes = set()
    for ln in lines:
        for g in ln.glyphs:
            if g.atom is not None:
                text_strokes.update(id(s) for s in g.atom.strokes)
    geometry = [s for s in strokes if id(s) not in text_strokes]
    boxes = _boxes(geometry, text_strokes)

    tag_lines = []
    for ln in lines:
        for tag in _tags(ln):
            info.tags.setdefault(tag, []).append(ln)
            tag_lines.append((tag, ln))
        ln.boxes = _attached_boxes(ln, boxes)

    xrefs = [x for ln in lines for x in _xrefs(ln)]
    used_tags = set()

    # contact labels: tag with a back-reference right below (or right of) it
    backref_of = {}
    for x in xrefs:
        H = x.line.height
        best = None
        for tag, ln in tag_lines:
            if ln is x.line:
                continue
            below = ln.rot == 0 and 0 <= x.line.y0 - ln.y1 < 1.6 * H and _overlap(ln.x0, ln.x1, x.line.x0, x.line.x1) > -0.5 * H
            vert = ln.rot != 0 and ln.rot == x.line.rot and abs(ln.cx - x.line.cx) < 2.5 * H and _overlap(ln.y0, ln.y1, x.line.y0, x.line.y1) > -H
            if below or vert:
                d = abs(x.line.cy - ln.cy) + abs(x.line.cx - ln.cx) * 0.2
                if best is None or d < best[0]:
                    best = (d, tag, ln)
        if best and not _row_terminals(x, lines):
            backref_of[id(x)] = (best[1], best[2])

    for x in xrefs:
        if id(x) not in backref_of:
            continue
        tag, ln = backref_of[id(x)]
        used_tags.add(id(ln))
        anchor, box = _contact_anchor(ln, x.line, geometry)
        z = info.zone_of(*anchor)
        if z:
            info.contacts.append(Contact(tag, info.index, ln, x, anchor, z, _near_terminals(anchor, ln, lines),
                                         zones=info.grid.zones(box) | {(z.row, z.col)}))

    # coil tables: rows "a  b  /S.ZN"
    rows = []
    for x in xrefs:
        if id(x) in backref_of:
            continue
        terms = _row_terminals(x, lines)
        if terms:
            rows.append(TableRow(terms, x))
    tables = _group_rows(rows)
    coil_tags = [(tag, ln) for tag, ln in tag_lines if id(ln) not in used_tags]
    for table in tables:
        tx0 = min(r.xref.line.x0 for r in table)
        tx1 = max(r.xref.line.x1 for r in table)
        ty0 = min(r.xref.line.y0 for r in table)
        H = table[0].xref.line.height
        best = None
        for tag, ln in coil_tags:
            if ln.cy > ty0 or ty0 - ln.cy > 45 * H:
                continue
            cx = (tx0 + tx1) / 2
            d = abs(_coil_anchor(ln, boxes)[0][0] - cx) + 0.15 * (ty0 - ln.cy)
            if best is None or d < best[0]:
                best = (d, tag, ln)
        if best is None:
            continue
        _, tag, ln = best
        anchor, box = _coil_anchor(ln, boxes)
        z = info.zone_of(*anchor)
        if not z:
            continue
        coil = next((c for c in info.coils if c.line is ln), None)
        if coil is None:
            coil = Coil(tag, info.index, ln, anchor, z, zones=info.grid.zones(box) | {(z.row, z.col)})
            info.coils.append(coil)
        coil.rows.extend(table)


def _row_terminals(x: XRef, lines: list[TextLine]) -> tuple[str, ...]:
    """Terminal numbers written on the same row as a cross-reference."""
    ln = x.line
    H = ln.height
    prefix = ln.text.replace(" ", "")
    k = prefix.find(f"/{x.sheet}")
    if k < 0:
        k = prefix.find("/")
    head = prefix[:k]
    terms = re.findall(r"[0-9]{1,3}[A-Z]?|[A-Z][0-9]{1,2}", head)
    cands = []
    for other in lines:
        if other is ln or other.rot != ln.rot or ln.rot != 0:
            continue
        if abs(other.cy - ln.cy) > 0.5 * H or other.x1 > ln.x0 + 0.1 * H or ln.x0 - other.x1 > 14 * H:
            continue
        t = other.text.replace(" ", "")
        if re.fullmatch(r"[0-9]{1,3}[A-Z]?|[A-Z][0-9]{1,2}", t):
            cands.append((other.x0, t))
    cands.sort()
    terms = [t for _, t in cands][-2:] + terms
    return tuple(terms[-2:])


def _group_rows(rows: list[TableRow]) -> list[list[TableRow]]:
    rows = sorted(rows, key=lambda r: (r.xref.line.cy, r.xref.line.x0))
    tables: list[list[TableRow]] = []
    for r in rows:
        ln = r.xref.line
        H = ln.height
        for t in tables:
            last = t[-1].xref.line
            if abs(last.x1 - ln.x1) < 3 * H and 0 < ln.cy - last.cy < 2.5 * H:
                t.append(r)
                break
        else:
            tables.append([r])
    return tables


def _attached_boxes(ln: TextLine, boxes) -> list[tuple]:
    """Device symbol boxes the tag labels: directly below it, around it, or right beside it."""
    H = ln.height
    out = []
    for b in boxes:
        if b[2] - b[0] < 2 * H and b[3] - b[1] < 2 * H:
            continue
        below = -0.5 * H < b[1] - ln.y1 < 2.5 * H and b[0] - H < ln.cx < b[2] + H
        inside = b[0] <= ln.x0 and ln.x1 <= b[2] and b[1] <= ln.y0 and ln.y1 <= b[3] and (b[2] - b[0]) < 40 * H
        beside = abs((b[1] + b[3]) / 2 - ln.cy) < 1.5 * H + (b[3] - b[1]) / 2 and 0 <= b[0] - ln.x1 < 2 * H
        if below or inside or beside:
            out.append(b)
    return out


def _coil_anchor(ln: TextLine, boxes):
    """Centre of the coil symbol drawn next to the tag (tags sit left of the coil by convention)."""
    H = ln.height
    best = None
    for b in boxes:
        if b[2] - b[0] > 60 or b[3] - b[1] > 40:
            continue
        bcx, bcy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if abs(bcy - ln.cy) > 1.5 * H + (b[3] - b[1]) / 2:
            continue
        if b[0] >= ln.x1 - 0.2 * H:
            gap, side = b[0] - ln.x1, 0
        elif b[2] <= ln.x0 + 0.2 * H:
            gap, side = ln.x0 - b[2], 1
        else:
            continue
        if gap > 3 * H:
            continue
        key = (side, gap)
        if best is None or key < best[0]:
            best = (key, (bcx, bcy), b)
    if best:
        return best[1], best[2]
    return (ln.cx, ln.cy), (ln.x0, ln.y0, ln.x1, ln.y1)


def _contact_anchor(tag_ln: TextLine, ref_ln: TextLine, geometry):
    """Locate the contact symbol: drawing geometry right beside the label block.

    Returns (anchor point, symbol bounding box)."""
    H = tag_ln.height
    x0, x1 = min(tag_ln.x0, ref_ln.x0), max(tag_ln.x1, ref_ln.x1)
    y0, y1 = min(tag_ln.y0, ref_ln.y0), max(tag_ln.y1, ref_ln.y1)
    cy = (y0 + y1) / 2
    best = None
    for st in geometry:
        if st.size < 1.5 * H:
            continue
        if st.y1 < y0 - H or st.y0 > y1 + H:
            continue
        sx = (st.x0 + st.x1) / 2
        if x0 - 5 * H < sx < x0:
            d, side = x0 - sx + 3 * H, -1  # labels normally sit left of their contact
        elif x1 < sx < x1 + 5 * H:
            d, side = sx - x1, 1
        else:
            continue
        if best is None or d < best[0]:
            best = (d, sx, side)
    if not best:
        return ((x0 + x1) / 2, cy), (x0, y0, x1, y1)
    _, sx, side = best
    # symbol box: geometry clipped to a window on that side of the label
    wx0, wx1 = (x1, x1 + 4 * H) if side > 0 else (x0 - 4 * H, x0)
    wy0, wy1 = y0 - H, y1 + H
    bx0, by0, bx1, by1 = sx, cy, sx, cy
    for st in geometry:
        if st.x1 < wx0 or st.x0 > wx1 or st.y1 < wy0 or st.y0 > wy1:
            continue
        if st.size > 1.5 * H and not (abs(st.x1 - st.x0) < 0.1 or abs(st.y1 - st.y0) < 0.1):
            pass
        bx0, bx1 = min(bx0, max(st.x0, wx0)), max(bx1, min(st.x1, wx1))
        by0, by1 = min(by0, max(st.y0, wy0)), max(by1, min(st.y1, wy1))
    return ((bx0 + bx1) / 2, cy), (bx0, by0, bx1, by1)


def _near_terminals(anchor, tag_ln, lines):
    H = tag_ln.height
    out = []
    for ln in lines:
        t = ln.text.replace(" ", "")
        if not re.fullmatch(r"\d{1,3}", t):
            continue
        if abs(ln.cx - anchor[0]) < 3 * H and abs(ln.cy - anchor[1]) < 6 * H:
            out.append(t)
    return tuple(out)


# --- BOM pages -------------------------------------------------------------

def parse_bom(page: pymupdf.Page, info: PageInfo, strokes) -> list[BomRow]:
    m = page.rotation_matrix
    words = [(pymupdf.Rect(w[:4]) * m, w[4]) for w in page.get_text("words")]
    heads = [r for r, t in words if t == "DESIGNATION"]
    heads += [pymupdf.Rect(ln.x0, ln.y0, ln.x1, ln.y1) for ln in info.lines
              if ln.text.replace(" ", "") == "DESIGNATION" and not any(abs(ln.x0 - r.x0) < 5 for r in heads)]
    # long vertical rules of the BOM tables
    rules = sorted({round(st.x0, 1) for st in strokes
                    if abs(st.x1 - st.x0) < 0.2 and st.y1 - st.y0 > 0.25 * info.height})
    out = []
    for hd in heads:
        cx = (hd.x0 + hd.x1) / 2
        left = [x for x in rules if x < cx]
        right = [x for x in rules if x > cx]
        if not left or not right:
            continue
        col0 = left[-1]
        # the SHEET labels sit just right of the designation column
        labels = [ln for ln in info.lines if ln.text.replace(" ", "") == "SHEET" and ln.y0 > hd.y1
                  and hd.x1 - 5 < ln.x0 < hd.x1 + 150 and ln.cy < 0.9 * info.height]
        if not labels:
            continue
        lx = min(ln.x0 for ln in labels)
        col1 = max([x for x in rules if hd.x1 - 2 < x <= lx + 1], default=lx - 1)
        table_end = min([x for x in rules if x > lx + 40], default=info.width)
        sheet_labels = sorted([ln for ln in labels if ln.x0 < lx + 30], key=lambda ln: ln.cy)
        prev_y = hd.y1
        for lab in sheet_labels:
            H = lab.height
            nums = [ln for ln in info.lines if ln is not lab and abs(ln.cy - lab.cy) < 0.6 * H and lab.x1 < ln.x0 < table_end]
            sheets = []
            for ln in nums:
                sheets.extend(_parse_sheet_list(ln.text))
            desig = [ln for ln in info.lines if col0 < ln.cx < col1 and prev_y < ln.cy < lab.y1 and ln.rot == 0]
            designations = []
            for ln in sorted(desig, key=lambda l: (l.cy, l.x0)):
                designations.extend(_parse_designations(ln.text))
            if designations:
                out.append(BomRow(info.index, designations, sorted(set(sheets)), desig, nums))
            prev_y = lab.y1
    return out


def _parse_sheet_list(text: str) -> list[int]:
    out = []
    for part in re.split(r"[,.\s]+", text):
        m = re.fullmatch(r"(\d{1,3})-(\d{1,3})", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a <= b <= a + 50:
                out.extend(range(a, b + 1))
        elif part.isdigit():
            out.append(int(part))
    return out


def _parse_designations(text: str) -> list[str]:
    out = []
    for part in re.split(r"[,.\s]+", text.strip()):
        part = part.strip("-")
        if not part:
            continue
        m = re.fullmatch(r"([0-9]*[A-Z]+)(\d+)-\1?(\d+)", part)
        if m:
            a, b = int(m.group(2)), int(m.group(3))
            if a <= b <= a + 200:
                out.extend(f"{m.group(1)}{k}" for k in range(a, b + 1))
                continue
        if re.fullmatch(r"[0-9]*[A-Z][A-Z0-9]*", part) and not part.isdigit():
            out.append(part)
    return out
