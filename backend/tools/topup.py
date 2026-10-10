"""Top-up labelling: find glyph shapes in new PDFs that the library does not cover.

usage:
  topup.py scan OUT_DIR PDF:PAGES [...]   -> OUT_DIR/new.json + OUT_DIR/top_XX.png (with proposals)
  topup.py apply OUT_DIR                  -> append labelled shapes (proposals + fix_*.txt) to the library
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pymupdf
from PIL import Image, ImageDraw

from schcheck.glyphs import descriptor, rotate_upright
from schcheck.strokes import extract_strokes, build_atoms
from schcheck.glyphs import atom_polylines
from schcheck.ocr import DATA
from autolabel import render

THR = 0.9


def load_db():
    entries = json.loads(DATA.read_text())
    D = [descriptor(e["polys"]) for e in entries]
    return entries, np.stack([d[0] for d in D]), np.log(np.array([d[3] for d in D]))


def token(e):
    if e["ch"] is None:
        return "~"
    return e["ch"] if e["rot"] == 0 else "r" + e["ch"]


def scan(out, specs):
    entries, V, LA = load_db()
    newv, newa, new = [], [], []
    for spec in specs:
        pdf, rng = spec.rsplit(":", 1)
        a, b = map(int, rng.split("-"))
        doc = pymupdf.open(pdf)
        for pno in range(a, b + 1):
            for at in build_atoms(extract_strokes(doc[pno - 1]), 12):
                if (at.w < 0.3 and at.h < 0.3) or max(at.w, at.h) > 10 or len(at.strokes) > 25:
                    continue
                polys = atom_polylines(at)
                v, _, _, asp = descriptor(polys)
                la = np.log(asp)
                s = V @ v - 0.5 * np.abs(LA - la)
                k = int(np.argmax(s))
                if s[k] >= THR:
                    continue
                if newv:
                    s2 = np.stack(newv) @ v - 0.5 * np.abs(np.array(newa) - la)
                    j = int(np.argmax(s2))
                    if s2[j] >= THR:
                        new[j]["n"] += 1
                        continue
                newv.append(v)
                newa.append(la)
                new.append({"n": 1, "pdf": pdf, "page": pno, "bbox": [at.x0, at.y0, at.x1, at.y1],
                            "polys": [[[round(x, 3), round(y, 3)] for x, y in pl] for pl in polys],
                            "prop": token(entries[k]), "sim": round(float(s[k]), 3)})
    new = [c for c in new if c["n"] >= 2]
    new.sort(key=lambda c: -c["n"])
    out.mkdir(parents=True, exist_ok=True)
    json.dump(new, open(out / "new.json", "w"))
    docs = {}
    CW, CH, COLS, ROWS = 250, 76, 6, 12
    for si in range(0, len(new), COLS * ROWS):
        sheet = Image.new("RGB", (CW * COLS, CH * ROWS), "white")
        d = ImageDraw.Draw(sheet)
        for j, c in enumerate(new[si:si + COLS * ROWS]):
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
            d.text((cx + 2, cy + 56), c["prop"], fill=(220, 0, 0))
            d.rectangle([cx, cy, cx + CW - 1, cy + CH - 1], outline=(190, 190, 190))
        sheet.save(out / f"top_{si // (COLS * ROWS):02d}.png")
    print(len(new), "new shapes", file=sys.stderr)


def apply(out):
    new = json.load(open(out / "new.json"))
    toks = [c["prop"] for c in new]
    for f in sorted(out.glob("fix_*.txt")):
        for item in f.read_text().split():
            k, tok = item.split(":", 1)
            toks[int(k)] = tok
    entries = json.loads(DATA.read_text())
    upright = {}
    for e in entries:
        if e["ch"] and e["rot"] == 0:
            v, _, _, a = descriptor(e["polys"])
            upright.setdefault(e["ch"], []).append((v, a))
    for c, tok in zip(new, toks):
        if tok == "~":
            entries.append({"ch": None, "rot": 0, "polys": c["polys"]})
            continue
        if tok.startswith("r") and len(tok) == 2:
            ch, best = tok[1], (-9, 1)
            for rot in (1, 3):
                v, _, _, a = descriptor(rotate_upright(c["polys"], rot))
                for uv, ua in upright.get(ch, []):
                    s = float(uv @ v) - 0.5 * abs(np.log(ua / a))
                    if s > best[0]:
                        best = (s, rot)
            entries.append({"ch": ch, "rot": best[1], "polys": c["polys"]})
        else:
            entries.append({"ch": tok, "rot": 0, "polys": c["polys"]})
    DATA.write_text(json.dumps(entries))
    print(len(entries), "templates", file=sys.stderr)


if __name__ == "__main__":
    if sys.argv[1] == "scan":
        scan(Path(sys.argv[2]), sys.argv[3:])
    else:
        apply(Path(sys.argv[2]))
