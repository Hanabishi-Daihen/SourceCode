"""Cross-sheet checks: BOM sheet lists, coil contact tables and contact back-references."""
from __future__ import annotations

import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from typing import Callable

import pymupdf

from .model import BomRow, Coil, Contact, PageInfo, XRef, analyse_page


@dataclass
class Mark:
    """A rectangle to highlight, in PDF display coordinates of a page."""
    page: int
    bbox: tuple[float, float, float, float]


@dataclass
class Finding:
    severity: str  # 'error' | 'warning'
    code: str
    message: str  # Thai, shown to the user
    fix: str  # what to change
    page: int  # page the finding is reported on (0-based)
    sheet: int | None
    marks: list[Mark] = field(default_factory=list)

    def to_dict(self):
        return asdict(self)


@dataclass
class Report:
    pages: list[dict]
    findings: list[Finding]
    stats: dict

    def to_dict(self):
        return {"pages": self.pages, "findings": [f.to_dict() for f in self.findings], "stats": self.stats}


def _bb(ln, pad=1.0):
    return (ln.x0 - pad, ln.y0 - pad, ln.x1 + pad, ln.y1 + pad)


def _xb(x: XRef, pad=1.0):
    b = x.bbox
    return (b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad)


_DOC = None


def _init_worker(path):
    global _DOC
    _DOC = pymupdf.open(path)


def _work(i):
    return analyse_page(_DOC[i], i)


def analyse(path: str, progress: Callable[[int, int], None] | None = None, workers: int | None = None) -> list[PageInfo]:
    """Analyse every page; pages are independent so they run in parallel processes."""
    n = len(pymupdf.open(path))
    workers = workers or min(os.cpu_count() or 1, 8)
    pages: list[PageInfo | None] = [None] * n
    done = 0
    if workers <= 1 or n < 3:
        _init_worker(path)
        for i in range(n):
            pages[i] = _work(i)
            if progress:
                progress(i + 1, n)
        return pages  # type: ignore[return-value]
    # each worker is single-threaded; numpy's own threads would only fight over the cores
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ.setdefault(var, "1")
    ctx = multiprocessing.get_context("spawn")
    with ProcessPoolExecutor(workers, mp_context=ctx, initializer=_init_worker, initargs=(path,)) as ex:
        futs = {ex.submit(_work, i): i for i in range(n)}
        for f in as_completed(futs):
            pages[futs[f]] = f.result()
            done += 1
            if progress:
                progress(done, n)
    return pages  # type: ignore[return-value]


def check(pages: list[PageInfo]) -> Report:
    findings: list[Finding] = []
    # sheet numbers restart in every drawing series (cover, outline, schematic ...), so a
    # cross-reference is resolved inside the series of the page it is written on
    _infer_series(pages)
    sheets: dict[tuple[str | None, int], PageInfo] = {}
    for p in pages:
        if p.sheet is not None and p.kind in ("schematic", "bom"):
            sheets.setdefault((p.series, p.sheet), p)

    class _BySheet:
        def __init__(self, series):
            self.series = series

        def get(self, sheet):
            return sheets.get((self.series, sheet))

    def by_series(page_index: int):
        return _BySheet(pages[page_index].series)

    coils: dict[str, list[Coil]] = {}
    contacts: dict[str, list[Contact]] = {}
    for p in pages:
        for c in p.coils:
            coils.setdefault(c.tag, []).append(c)
        for c in p.contacts:
            contacts.setdefault(c.tag, []).append(c)

    def occurrences(page: PageInfo, tag: str):
        """Places where the tag is written on a page, with the zones around the text."""
        out = []
        for ln in page.tags.get(tag, []):
            H = ln.height
            # tags sit left of their symbol: look a little further to the right
            box = (ln.x0 - 1.5 * H, ln.y0 - 1.5 * H, ln.x1 + 4 * H, ln.y1 + 1.5 * H)
            zones = page.grid.zones(box)
            for b in ln.boxes:
                zones |= page.grid.zones(b)
            out.append((ln, zones))
        return out

    def zs(z) -> str:
        return f"/{z.sheet:02d}.{z.row}{z.col}" if z.sheet is not None else str(z)

    # 1) coil contact tables -> contact really drawn at that sheet/zone?
    for tag, cl in coils.items():
        for coil in cl:
            sheet_here = pages[coil.page].sheet
            by_sheet = by_series(coil.page)
            for row in coil.rows:
                x = row.xref
                target = by_sheet.get(x.sheet)
                term = "-".join(row.terminals)
                if target is None:
                    findings.append(Finding(
                        "error", "XREF_SHEET_MISSING",
                        f"-{tag} contact {term} อ้างถึง SHEET {x.sheet:02d} ซึ่งไม่มีในชุดแบบ",
                        f"ตรวจสอบเลข SHEET ของ {x}", coil.page, sheet_here, [Mark(coil.page, _xb(x))]))
                    continue
                here = [c for c in contacts.get(tag, []) if c.page == target.index]
                if any(x.in_zones(c.zone.sheet, c.zones) for c in here):
                    continue
                occ = occurrences(target, tag)
                if any(x.in_zones(target.sheet, z) for _, z in occ):
                    continue
                match = [c for c in here if set(row.terminals) & set(c.terminals)] or here
                if match:
                    best = match[0]
                    findings.append(Finding(
                        "error", "COIL_TABLE_ZONE",
                        f"-{tag} contact {term}: ตารางใต้ coil ระบุ {x} แต่ contact อยู่ที่ {zs(best.zone)}",
                        f"แก้ {x} เป็น {zs(best.zone)}", coil.page, sheet_here,
                        [Mark(coil.page, _xb(x)), Mark(best.page, _bb(best.line))]))
                elif occ:
                    ln = occ[0][0]
                    z = target.zone_of(ln.cx, ln.cy)
                    findings.append(Finding(
                        "error", "COIL_TABLE_ZONE",
                        f"-{tag} contact {term}: ตารางใต้ coil ระบุ {x} แต่พบ -{tag} ที่ {zs(z)}",
                        f"แก้ {x} เป็น {zs(z)}", coil.page, sheet_here,
                        [Mark(coil.page, _xb(x))] + [Mark(target.index, _bb(o)) for o, _ in occ]))
                else:
                    findings.append(Finding(
                        "error", "COIL_TABLE_MISSING",
                        f"-{tag} contact {term}: ตารางใต้ coil ระบุ {x} แต่ไม่พบ -{tag} ใน SHEET {x.sheet:02d}",
                        f"ตรวจสอบ contact ของ -{tag} หรือแก้ {x}", coil.page, sheet_here,
                        [Mark(coil.page, _xb(x))]))

    # 2) contacts -> back-reference points at the coil/device, and the coil table lists the contact
    for tag, cl in contacts.items():
        coil_list = coils.get(tag, [])
        for c in cl:
            ref = c.backref
            here = zs(c.zone)
            by_sheet = by_series(c.page)
            if ref is not None:
                target = by_sheet.get(ref.sheet)
                ok = any(ref.in_zones(k.zone.sheet, k.zones) for k in coil_list)
                occ = occurrences(target, tag) if target else []
                if not ok and target is not None:
                    ok = any(ref.in_zones(target.sheet, z) for ln, z in occ
                             if not any(ln is k.line for k in contacts.get(tag, [])))
                if not ok:
                    if target is None:
                        findings.append(Finding(
                            "error", "BACKREF_SHEET_MISSING",
                            f"contact -{tag} ที่ {here} อ้างถึง {ref} แต่ไม่มี SHEET {ref.sheet:02d} ในชุดแบบ",
                            f"ตรวจสอบเลข SHEET ใน {ref}", c.page, c.zone.sheet, [Mark(c.page, _xb(ref))]))
                    elif coil_list:
                        k = coil_list[0]
                        findings.append(Finding(
                            "error", "BACKREF_ZONE",
                            f"contact -{tag} ที่ {here} ระบุตำแหน่ง coil เป็น {ref} แต่ coil -{tag} อยู่ที่ {zs(k.zone)}",
                            f"แก้ {ref} เป็น {zs(k.zone)}", c.page, c.zone.sheet,
                            [Mark(c.page, _xb(ref)), Mark(k.page, _bb(k.line))]))
                    elif occ:
                        ln = occ[0][0]
                        z = target.zone_of(ln.cx, ln.cy)
                        findings.append(Finding(
                            "error", "BACKREF_ZONE",
                            f"contact -{tag} ที่ {here} ระบุตำแหน่งอุปกรณ์เป็น {ref} แต่พบ -{tag} ที่ {zs(z)}",
                            f"แก้ {ref} เป็น {zs(z)}", c.page, c.zone.sheet,
                            [Mark(c.page, _xb(ref))] + [Mark(target.index, _bb(o)) for o, _ in occ]))
                    else:
                        findings.append(Finding(
                            "error", "BACKREF_NOT_FOUND",
                            f"contact -{tag} ที่ {here} อ้างถึง {ref} แต่ไม่พบ -{tag} ใน SHEET {ref.sheet:02d}",
                            f"ตรวจสอบตำแหน่งอุปกรณ์ -{tag} หรือแก้ {ref}", c.page, c.zone.sheet,
                            [Mark(c.page, _xb(ref))]))
            if coil_list and coil_list[0].rows:
                listed = any(r.xref.in_zones(c.zone.sheet, c.zones) for k in coil_list for r in k.rows)
                if not listed:
                    k = coil_list[0]
                    findings.append(Finding(
                        "error", "CONTACT_NOT_LISTED",
                        f"contact -{tag} ที่ {here} ไม่มีอยู่ในตารางใต้ coil -{tag}",
                        f"เพิ่ม/แก้ตาราง contact ใต้ coil -{tag} ให้มี {here}", c.page, c.zone.sheet,
                        [Mark(c.page, _bb(c.line))] + [Mark(k.page, _xb(r.xref)) for r in k.rows]))

    # 3) BOM: every designation must appear on (at least one of) the sheets listed in its row
    bom_tags: set[str] = set()
    for p in pages:
        by_sheet = by_series(p.index)
        same_series = [q for q in pages if q.kind == "schematic" and q.series == p.series and q.sheet is not None]
        for row in p.bom_rows:
            listed = [s for s in row.sheets]
            missing_sheets = [s for s in listed if by_sheet.get(s) is None]
            for s in missing_sheets:
                findings.append(Finding(
                    "error", "BOM_SHEET_MISSING", f"BOM: {', '.join(row.designations[:4])} ระบุ SHEET {s:02d} ซึ่งไม่มีในชุดแบบ",
                    f"แก้เลข SHEET {s:02d}", p.index, p.sheet, [Mark(p.index, _bb(ln)) for ln in row.sheet_lines]))
            for d in row.designations:
                bom_tags.add(d)
                found_on = sorted({q.sheet for q in same_series if d in q.tokens})
                if not listed or any(s in found_on for s in listed):
                    continue
                desig_marks = [Mark(p.index, _bb(ln)) for ln in row.desig_lines if d in ln.text.replace(" ", "")]
                if found_on:
                    where = ", ".join(f"{s:02d}" for s in found_on)
                    findings.append(Finding(
                        "error", "BOM_NOT_ON_SHEET",
                        f"BOM: {d} ระบุ SHEET {', '.join(f'{s:02d}' for s in listed)} แต่พบ -{d} ที่ SHEET {where}",
                        f"แก้ช่อง SHEET ของ {d} เป็น {where}", p.index, p.sheet,
                        desig_marks + [Mark(p.index, _bb(ln)) for ln in row.sheet_lines]))
                else:
                    findings.append(Finding(
                        "warning", "BOM_NOT_FOUND",
                        f"BOM: ไม่พบ -{d} ใน SHEET {', '.join(f'{s:02d}' for s in listed)} (และไม่พบในหน้าอื่น)",
                        f"ตรวจสอบชื่ออุปกรณ์ {d} ในแบบ", p.index, p.sheet, desig_marks))
            for s in listed:
                q = by_sheet.get(s)
                if q is not None and not any(d in q.tokens for d in row.designations):
                    findings.append(Finding(
                        "warning", "BOM_SHEET_UNUSED",
                        f"BOM: SHEET {s:02d} ไม่มีอุปกรณ์ในแถวนี้ ({', '.join(row.designations[:4])}{'...' if len(row.designations) > 4 else ''})",
                        f"ตรวจสอบเลข SHEET {s:02d}", p.index, p.sheet, [Mark(p.index, _bb(ln)) for ln in row.sheet_lines]))

    # 4) coils on schematics that the BOM does not list (only when a BOM exists)
    if bom_tags:
        for tag, cl in coils.items():
            if tag not in bom_tags:
                c = cl[0]
                findings.append(Finding(
                    "warning", "NOT_IN_BOM", f"coil -{tag} ไม่มีใน BOM", f"เพิ่ม {tag} ใน BOM",
                    c.page, c.zone.sheet, [Mark(c.page, _bb(c.line))]))

    seen, unique = set(), []
    for f in findings:
        key = (f.code, f.message)
        if key not in seen:
            seen.add(key)
            unique.append(f)
    findings = unique

    stats = {
        "pages": len(pages),
        "schematic_pages": sum(1 for p in pages if p.kind == "schematic"),
        "bom_pages": sum(1 for p in pages if p.kind == "bom"),
        "coils": sum(len(v) for v in coils.values()),
        "contact_rows": sum(len(c.rows) for v in coils.values() for c in v),
        "contacts": sum(len(v) for v in contacts.values()),
        "bom_designations": len(bom_tags),
        "errors": sum(1 for f in findings if f.severity == "error"),
        "warnings": sum(1 for f in findings if f.severity == "warning"),
    }
    page_meta = [{"index": p.index, "sheet": p.sheet, "series": p.series, "kind": p.kind,
                  "width": p.width, "height": p.height}
                 for p in pages]
    return Report(page_meta, findings, stats)


def _infer_series(pages: list[PageInfo]):
    """Pages whose drawing number could not be read take the series of their neighbours."""
    for i, p in enumerate(pages):
        if p.series is not None or p.sheet is None:
            continue
        prev = next((q for q in reversed(pages[:i]) if q.series and q.sheet is not None), None)
        nxt = next((q for q in pages[i + 1:] if q.series and q.sheet is not None), None)
        if prev and prev.sheet < p.sheet and (nxt is None or nxt.series != prev.series or nxt.sheet > p.sheet):
            p.series = prev.series
        elif nxt and nxt.sheet > p.sheet:
            p.series = nxt.series


def run(path: str, progress=None) -> Report:
    return check(analyse(path, progress))
