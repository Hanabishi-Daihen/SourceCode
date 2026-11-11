// Synthetic schematic sheets for testing without customer drawings.
//
// Text is drawn stroke by stroke with the glyph shapes collected from real plots, on
// sheets laid out like the real ones (zone border, title block, coils with contact
// tables, contacts with back-references).  A scenario builds sheets with known mistakes
// in them; the checker must report exactly those.
import fs from "node:fs";

export const W = 1191, H = 842; // A3 landscape, points
const COL0 = 60, COLW = 107.1, ROW0 = 57, ROWH = 85.7;
export const COLS = 10, ROWS = "ABCDEFGHI";

// --- font ------------------------------------------------------------------------

const src = JSON.parse(fs.readFileSync(new URL("../../backend/schcheck/data/glyphs.json", import.meta.url)));
const FONT = new Map();
{
  const cands = new Map();
  for (const e of src) {
    if (!e.ch || e.rot !== 0 || "|-./,_()+".includes(e.ch)) continue;
    const pts = e.polys.flat();
    const x0 = Math.min(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1]));
    const w = Math.max(...pts.map((p) => p[0])) - x0, h = Math.max(...pts.map((p) => p[1])) - y0;
    if (h < 2) continue;
    if (!cands.has(e.ch)) cands.set(e.ch, []);
    cands.get(e.ch).push({ w, h, polys: e.polys.map((pl) => pl.map((p) => [p[0] - x0, p[1] - y0])) });
  }
  const lower = "abcdefghijklmnopqrstuvwxyz";
  for (const [ch, list] of cands) {
    // the single-stroke drawing font: capitals 7.32 high, drawn with few polylines
    const want = lower.includes(ch) && !"bdfhklt".includes(ch) ? 5.0 : 7.32;
    list.sort((a, b) => Math.abs(a.h - want) - Math.abs(b.h - want) || a.polys.length - b.polys.length);
    const g = list[0];
    FONT.set(ch, { w: g.w / 7.32 * (7.32 / g.h) * (want / 7.32), h: want / 7.32, polys: g.polys.map((pl) => pl.map((p) => [p[0] / g.h * (want / 7.32), p[1] / g.h * (want / 7.32)])) });
  }
}

/** Polylines of `text` with capital height `size`, upright, origin at the top-left corner. */
function textPolys(text, size, flag1 = true) {
  const out = [];
  let x = 0;
  for (const ch of text) {
    if (ch === " ") { x += 0.75 * size; continue; }
    // "1" has a small flag in most plots; flag1 = false draws the plain bar of other fonts
    if (ch === "1" && flag1) { out.push([[x, 0.25 * size], [x + 0.18 * size, 0], [x + 0.18 * size, size]]); x += 0.45 * size; continue; }
    if (ch === "1") { out.push([[x + 0.15 * size, 0], [x + 0.15 * size, size]]); x += 0.5 * size; continue; }
    if (ch === "-") { out.push([[x, 0.55 * size], [x + 0.45 * size, 0.55 * size]]); x += 0.65 * size; continue; }
    if (ch === ".") { out.push([[x + 0.05 * size, size - 0.3], [x + 0.05 * size, size]]); x += 0.3 * size; continue; }
    if (ch === "+") { out.push([[x, 0.55 * size], [x + 0.5 * size, 0.55 * size]], [[x + 0.25 * size, 0.3 * size], [x + 0.25 * size, 0.8 * size]]); x += 0.7 * size; continue; }
    if (ch === "/") { out.push([[x, size * 1.05], [x + 0.45 * size, -0.05 * size]]); x += 0.6 * size; continue; }
    const g = FONT.get(ch);
    if (!g) throw new Error(`no glyph for "${ch}"`);
    const top = (1 - g.h) * size; // lower-case letters sit on the baseline
    for (const pl of g.polys) out.push(pl.map((p) => [x + p[0] * size, top + p[1] * size]));
    x += g.w * size + 0.22 * size;
  }
  return { polys: out, width: x - 0.22 * size };
}

// --- sheets ------------------------------------------------------------------------

export class Sheet {
  constructor(number, { series = "CD-PPTEST-4S", titled = true, border = true } = {}) {
    this.number = number;
    this.strokes = []; // [[x, y], ...] polylines, display points
    if (border) this.border();
    if (titled) this.titleBlock(series, number);
  }

  line(...pts) { this.strokes.push(pts); return this; }
  rect(x0, y0, x1, y1) { return this.line([x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]); }
  dashed(x0, y0, x1, y1, dash = 6, gap = 3) {
    const L = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    for (let d = 0; d < L; d += dash + gap) {
      const e = Math.min(L, d + dash);
      this.line([x0 + ux * d, y0 + uy * d], [x0 + ux * e, y0 + uy * e]);
    }
    return this;
  }

  /**
   * Text with capital height `size`.  rot 0 reads left to right from (x, y) = top-left;
   * rot 1 reads bottom to top, (x, y) = bottom-left of the turned text.
   * align "right"/"center" shifts along the reading direction.  Returns the box.
   */
  text(x, y, str, size = 7.32, { rot = 0, align = "left", flag1 = true } = {}) {
    const { polys, width } = textPolys(str, size, flag1);
    const shift = align === "right" ? -width : align === "center" ? -width / 2 : 0;
    for (const pl of polys) {
      this.strokes.push(pl.map(([u, v]) => (rot === 0 ? [x + u + shift, y + v] : [x + v, y - u - shift])));
    }
    return rot === 0 ? [x + shift, y, x + shift + width, y + size] : [x, y - shift - width, x + size, y - shift];
  }

  border() {
    this.rect(18, 18, W - 18, H - 14);
    for (let c = 1; c <= COLS; c++) {
      const cx = COL0 + COLW * (c - 0.5);
      this.text(cx, 5, String(c), 7.3, { align: "center", flag1: true });
      this.text(cx, H - 12, String(c), 7.3, { align: "center", flag1: true });
      if (c < COLS) this.line([COL0 + COLW * c, 2], [COL0 + COLW * c, 18]);
    }
    [...ROWS].forEach((r, k) => {
      const cy = ROW0 + ROWH * (k + 0.5);
      this.text(7, cy - 2.7, r, 5.4);
      this.text(W - 13, cy - 2.7, r, 5.4);
      if (k + 1 < ROWS.length) this.line([2, ROW0 + ROWH * (k + 1)], [18, ROW0 + ROWH * (k + 1)]);
    });
  }

  titleBlock(series, number) {
    const y = 728;
    this.rect(30, y, W - 30, H - 22);
    this.line([640, y], [640, H - 22]).line([870, y], [870, H - 22]).line([1100, y], [1100, H - 22]);
    this.text(650, y + 8, "DRAWING NO.", 6.2);
    this.text(660, y + 24, `${series}-${String(number).padStart(2, "0")}`, 9);
    this.text(880, y + 8, "DESCRIPTION", 6.2);
    this.text(1120, y + 8, "SHEET", 6.2);
    this.text(1128, y + 28, String(number).padStart(2, "0"), 9);
  }

  // --- zones ---

  static zone(z) {
    const row = ROWS.indexOf(z[0]), col = parseInt(z.slice(1), 10);
    return { x0: COL0 + COLW * (col - 1), y0: ROW0 + ROWH * row, x1: COL0 + COLW * col, y1: ROW0 + ROWH * (row + 1) };
  }
  /** A point in a zone: fx, fy in 0..1 across it (0.5 = centre). */
  static at(z, fx = 0.5, fy = 0.5) {
    const b = Sheet.zone(z);
    return [b.x0 + (b.x1 - b.x0) * fx, b.y0 + (b.y1 - b.y0) * fy];
  }

  // --- devices ---

  /** One row of a contact table: terminals "a" and "b" (b may be ""), reference text. */
  tableRow(x, y, a, b, ref) {
    if (a) this.text(x, y + 1, a, 3.3, { align: "right" });
    this.line([x + 3, y + 2.8], [x + 9, y + 2.8], [x + 14, y + 0.6]).line([x + 14, y + 2.8], [x + 20, y + 2.8]);
    if (b) this.text(x + 22, y + 1, b, 3.3);
    if (ref) this.text(x + 31, y, ref, 4.5);
  }

  /**
   * Coil with its tag left of the box and the contact table under it.
   * rows: [[a, b, ref], ...].  opts: fx/fy place the box in the zone, double = SET/RESET
   * pair of boxes, tableDx shifts the table sideways, tableAbove puts it over the box.
   */
  coil(tag, z, rows = [], { fx = 0.5, fy = 0.5, double = false, tableDx = 0, tableAbove = false, inside = false, label = "" } = {}) {
    const [cx, cy] = Sheet.at(z, fx, fy);
    const bw = double ? 86 : inside ? 90 : 34, bh = inside ? 40 : 20;
    const bx0 = cx - bw / 2, by0 = cy - bh / 2;
    if (double) { this.rect(bx0, by0, cx, by0 + bh); this.rect(cx, by0, bx0 + bw, by0 + bh); } else this.rect(bx0, by0, bx0 + bw, by0 + bh);
    if (inside) this.text(cx, cy - 6, `-${tag}`, 12, { align: "center" });
    else this.text(bx0 - 5, cy - 4.5, `-${tag}`, 9, { align: "right" });
    this.line([cx, by0 - 40], [cx, by0]).line([cx, by0 + bh], [cx, by0 + bh + 22]);
    if (label) this.text(cx, by0 + bh + 34, label, 8, { align: "center" });
    const ty = tableAbove ? by0 - 12 - 8.2 * rows.length : by0 + bh + (label ? 56 : 34);
    rows.forEach(([a, b, ref], k) => this.tableRow(cx - 30 + tableDx, ty + 8.2 * k, a, b, ref));
    return [cx, cy];
  }

  /**
   * Contact on a vertical wire with its label (tag over back-reference) left of it.
   * terms: [top, bottom] terminal numbers.  opts.vertical writes the label turned.
   */
  contact(tag, z, backref, terms = [], { fx = 0.5, fy = 0.5, dash = true, vertical = false } = {}) {
    const [cx, cy] = Sheet.at(z, fx, fy);
    this.line([cx, cy - 42], [cx, cy - 12]).line([cx, cy + 12], [cx - 9, cy - 11]).line([cx, cy + 12], [cx, cy + 42]);
    const name = `${dash ? "-" : ""}${tag}`;
    if (vertical) {
      this.text(cx - 26, cy + 14, name, 8, { rot: 1 });
      if (backref) this.text(cx - 15, cy + 14, backref, 7.2, { rot: 1 });
    } else {
      this.text(cx - 13, cy - 11, name, 8.2, { align: "right" });
      if (backref) this.text(cx - 13, cy + 0.5, backref, 7.2, { align: "right" });
    }
    if (terms[0]) this.text(cx + 3, cy - 16, terms[0], 6, { rot: 1 });
    if (terms[1]) this.text(cx + 3, cy + 30, terms[1], 6, { rot: 1 });
    return [cx, cy];
  }

  /** Contact on a horizontal wire, the label written above it (as on stacked aux contacts). */
  contactSideways(tag, z, backref, terms = [], { fx = 0.5, fy = 0.5 } = {}) {
    const [cx, cy] = Sheet.at(z, fx, fy);
    const y = cy + 16;
    this.line([cx - 45, y], [cx - 10, y]).line([cx + 10, y], [cx - 9, y + 9]).line([cx + 10, y], [cx + 45, y]);
    this.text(cx, cy - 14, `-${tag}`, 8.2, { align: "center" });
    if (backref) this.text(cx, cy - 3, backref, 7.2, { align: "center" });
    if (terms[0]) this.text(cx - 30, y - 8, terms[0], 5.5);
    if (terms[1]) this.text(cx + 18, y - 8, terms[1], 5.5);
    return [cx, cy];
  }

  /** Three-pole breaker: tag, handle symbol, then the pole boxes to the lower right. */
  breaker(tag, z, rows = [], { fx = 0.3, fy = 0.4 } = {}) {
    const [x, y] = Sheet.at(z, fx, fy);
    const tb = this.text(x, y - 4, `-${tag}`, 8, { align: "right" });
    // handle: an open figure, not a rectangle
    this.line([x + 6, y], [x + 10, y], [x + 10, y - 4], [x + 6, y - 4], [x + 6, y + 4], [x + 14, y + 4], [x + 14, y - 4], [x + 10, y - 4]);
    const bx = x + 24, by = y + 12;
    for (let k = 0; k < 3; k++) {
      this.rect(bx + 17 * k, by, bx + 17 * (k + 1), by + 9).rect(bx + 17 * k, by + 9, bx + 17 * (k + 1), by + 18);
      this.line([bx + 17 * k + 8, by - 30], [bx + 17 * k + 8, by]).line([bx + 17 * k + 8, by + 18], [bx + 17 * k + 8, by + 50]);
    }
    rows.forEach(([a, b, ref], k) => this.tableRow(tb[0] + 6, y + 14 + 6.5 * k, a, b, ref));
    return [bx + 25, by + 9];
  }

  /** Wire leaving the sheet: "name > /SS.ZN" (not a contact reference). */
  arrow(x, y, ref, { name = "DC+.2", left = false } = {}) {
    if (left) {
      this.text(x, y - 4, ref, 7.7);
      const e = x + 34;
      this.line([e, y - 4.4], [e + 13, y], [e, y + 4.4], [e, y - 4.4]).line([e + 13, y], [e + 60, y]);
      this.text(e + 18, y - 10, name, 6.8);
    } else {
      this.line([x - 60, y], [x - 16, y]).line([x - 16, y - 4.4], [x - 3, y], [x - 16, y + 4.4], [x - 16, y - 4.4]);
      this.text(x - 55, y - 10, name, 6.8);
      this.text(x + 2, y - 4, ref, 7.7);
    }
  }
}

// --- running the checker on sheets ---------------------------------------------------

/**
 * Page sources for SC.analysePage, one per sheet.  `grid` snaps every point to a plot
 * raster of that many points, the way a plotter driver does (AutoCAD PDFs: 0.12), which
 * bends small text a little; `shift` moves the sheet off the raster first.
 */
export function sources(SC, sheets, { grid = 0.001, shift = 0 } = {}) {
  const q = (v) => Math.round((Math.round((v + shift) / grid) * grid) * 1000) / 1000;
  return sheets.map((s, i) => ({
    index: i, width: W, height: H, textItems: [], viewportTransform: [1, 0, 0, 1, 0, 0],
    strokes: s.strokes.map((pl) => new SC.Stroke(pl.map((p) => [q(p[0]), q(p[1])]))),
  }));
}

/** The sheets as a PDF (plain stroked paths, like an AutoCAD plot of SHX text). */
export async function toPdf(sheets) {
  const { PDFDocument, pushGraphicsState, popGraphicsState, moveTo, lineTo, stroke, setLineWidth } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (const s of sheets) {
    const page = doc.addPage([W, H]);
    const ops = [pushGraphicsState(), setLineWidth(0.35)];
    for (const pl of s.strokes) {
      ops.push(moveTo(pl[0][0], H - pl[0][1]));
      for (let k = 1; k < pl.length; k++) ops.push(lineTo(pl[k][0], H - pl[k][1]));
      ops.push(stroke());
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  }
  return doc.save();
}
