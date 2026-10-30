/* Page model: sheet number, drawing series, zone grid and the elements the checker needs. */
(function (SC) {
  "use strict";

  const XREF = /\/(\d{1,3})\.([A-L])(\d{1,2})/g;
  const TAG = /-([0-9]*[A-Z][A-Z0-9]*)/g;
  const DIGITS = /^\d{1,3}$/;
  // words that appear after a dash in switch labels ("ON-OFF") but are not device tags
  const NOT_TAGS = new Set(["ON", "OFF", "AUTO", "MAN", "MANUAL", "TEST", "RESET", "LOCAL", "REMOTE", "RAISE",
    "LOWER", "STOP", "START", "OPEN", "CLOSE", "TRIP", "ALARM", "SPARE", "GND", "PE"]);
  const TERM = /^(?:[0-9]{1,3}[A-Z]?|[A-Z][0-9]{1,2})$/;

  const compact = (s) => s.replace(/ /g, "");
  const isAlnum = (c) => /[\p{L}\p{N}]/u.test(c);
  const zkey = (row, col) => row + col;
  const pad2 = (n) => String(n).padStart(2, "0");

  // --- grid -------------------------------------------------------------------

  class Grid {
    constructor(cols, rows, colTicks, rowTicks) {
      this.cols = cols; // [[label, centre x]]
      this.rows = rows; // [[label, centre y]]
      this.colTicks = colTicks || [];
      this.rowTicks = rowTicks || [];
    }
    zone(x, y) {
      if (!this.cols.length || !this.rows.length) return null;
      return [cell(this.rows, this.rowTicks, y), cell(this.cols, this.colTicks, x)];
    }
    /** Every zone a rectangle touches (slightly shrunk so a hairline overlap does not count). */
    zones(box) {
      const [x0, y0, x1, y1] = box;
      const dx = Math.min(0.5, (x1 - x0) / 4), dy = Math.min(0.5, (y1 - y0) / 4);
      const out = new Set();
      for (const x of [x0 + dx, (x0 + x1) / 2, x1 - dx]) {
        for (const y of [y0 + dy, (y0 + y1) / 2, y1 - dy]) {
          const z = this.zone(x, y);
          if (z) out.add(zkey(z[0], z[1]));
        }
      }
      return out;
    }
  }

  function cell(cells, ticks, v) {
    if (ticks.length) {
      const k = ticks.filter((t) => t <= v).length;
      for (const [lab, c] of cells) if (ticks.filter((t) => t <= c).length === k) return lab;
    }
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k][1];
      const lo = k ? (cells[k - 1][1] + c) / 2 : -Infinity;
      const hi = k + 1 < cells.length ? (c + cells[k + 1][1]) / 2 : Infinity;
      if (lo <= v && v < hi) return cells[k][0];
    }
    return cells[0][0];
  }

  function ticks(strokes, w, h) {
    const xs = [], ys = [];
    for (const st of strokes) {
      if (st.pts.length !== 2) continue;
      const [[ax, ay], [bx, by]] = st.pts;
      if (Math.abs(ax - bx) < 0.05 && Math.abs(ay - by) > 0.004 * h && Math.abs(ay - by) < 0.04 * h && Math.max(ay, by) < 0.07 * h) xs.push(ax);
      if (Math.abs(ay - by) < 0.05 && Math.abs(ax - bx) > 0.004 * w && Math.abs(ax - bx) < 0.04 * w && Math.max(ax, bx) < 0.06 * w) ys.push(ay);
    }
    return [dedupe(xs), dedupe(ys)];
  }

  function dedupe(vals, tol = 1.0) {
    const out = [];
    for (const v of vals.slice().sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
    return out;
  }

  function monotonic(cells, key) {
    const out = [];
    for (const [lab, c] of cells) if (!out.length || key(lab) > key(out[out.length - 1][0])) out.push([lab, c]);
    return out.length >= 3 ? out : [];
  }

  function median(a) {
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }

  function dropOutliers(cells) {
    if (cells.length < 4) return cells;
    const steps = [];
    for (let i = 0; i + 1 < cells.length; i++) steps.push((cells[i + 1][1] - cells[i][1]) / (cells[i + 1][0] - cells[i][0]));
    const step = median(steps);
    const base = median(cells.map(([k, c]) => c - k * step));
    return cells.filter(([k, c]) => Math.abs(c - (base + k * step)) < 0.25 * step);
  }

  function fill(cells, idx, lab, limit) {
    if (cells.length < 3) return cells;
    const known = new Map(cells.map(([l, c]) => [idx(l), c]));
    const ks = [...known.keys()].sort((a, b) => a - b);
    const steps = [];
    for (let i = 0; i + 1 < ks.length; i++) steps.push((known.get(ks[i + 1]) - known.get(ks[i])) / (ks[i + 1] - ks[i]));
    const step = median(steps);
    const out = new Map(known);
    for (let k = ks[0]; k <= ks[ks.length - 1]; k++) {
      if (!out.has(k)) {
        const a = Math.max(...ks.filter((x) => x < k));
        out.set(k, known.get(a) + (k - a) * step);
      }
    }
    let k = ks[0] - 1;
    while (k >= 1 && out.get(k + 1) - step > step * 0.4) { out.set(k, out.get(k + 1) - step); k--; }
    k = ks[ks.length - 1] + 1;
    while (out.get(k - 1) + step < limit - step * 0.3 && k - ks[ks.length - 1] <= 2) { out.set(k, out.get(k - 1) + step); k++; }
    return [...out.keys()].sort((a, b) => a - b).map((k2) => [lab(k2), out.get(k2)]);
  }

  function usableTicks(tk, cells) {
    if (cells.length < 2) return [];
    const keep = [];
    for (let i = 0; i + 1 < cells.length; i++) {
      const a = cells[i][1], b = cells[i + 1][1];
      const between = tk.filter((t) => a < t && t < b);
      if (between.length !== 1) return [];
      keep.push(between[0]);
    }
    return keep;
  }

  function findGrid(lines, w, h, strokes) {
    const cols = new Map(), rows = new Map();
    for (const ln of lines) {
      const t = ln.text.trim();
      if (ln.rot === 0 && DIGITS.test(t) && ln.cy < 0.06 * h) {
        const k = parseInt(t, 10);
        if (!cols.has(k)) cols.set(k, []);
        cols.get(k).push(ln.cx);
      }
      if (ln.rot === 0 && /^[A-L]$/.test(t) && (ln.cx < 0.05 * w || ln.cx > 0.95 * w)) {
        if (!rows.has(t)) rows.set(t, []);
        rows.get(t).push(ln.cy);
      }
    }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    let colList = [...cols].filter(([k]) => k >= 1 && k <= 20).map(([k, v]) => [k, avg(v)]).sort((a, b) => a[1] - b[1]);
    let rowList = [...rows].map(([k, v]) => [k, avg(v)]).sort((a, b) => a[1] - b[1]);
    colList = dropOutliers(monotonic(colList, (l) => l));
    rowList = monotonic(rowList, (r) => r.charCodeAt(0));
    rowList = dropOutliers(rowList.map(([r, y]) => [r.charCodeAt(0) - 64, y])).map(([k, y]) => [String.fromCharCode(64 + k), y]);
    colList = fill(colList, (l) => l, (k) => k, 0.97 * w);
    rowList = fill(rowList, (l) => l.charCodeAt(0) - 64, (k) => String.fromCharCode(64 + k), 0.97 * h);
    const [cx, ry] = ticks(strokes || [], w, h);
    return new Grid(colList, rowList, usableTicks(cx, colList), usableTicks(ry, rowList));
  }

  // --- title block ---------------------------------------------------------------

  function findSheetNumber(lines, w, h) {
    const labels = lines.filter((ln) => compact(ln.text) === "SHEET" && ln.cx > 0.6 * w && ln.cy > 0.75 * h);
    if (!labels.length) return null;
    const lab = labels.reduce((a, b) => (b.cx + b.cy > a.cx + a.cy ? b : a));
    let best = null;
    for (const ln of lines) {
      const t = compact(ln.text);
      if (!/^\d+$/.test(t) || ln === lab) continue;
      if (ln.y0 < lab.y1 - 0.2 * lab.height || ln.y0 > lab.y1 + 6 * lab.height) continue;
      if (ln.cx < lab.x0 - 3 * lab.height || ln.cx > lab.x1 + 3 * lab.height) continue;
      const d = ln.y0 - lab.y1;
      if (!best || d < best[0]) best = [d, parseInt(t, 10)];
    }
    return best ? best[1] : null;
  }

  // "DRAWING NO." of the title block; the "NO." is often read as a separate word
  const isDwgLabel = (ln, h) => ln.rot === 0 && ln.cy > 0.75 * h && /^DRAWING(NO\.?)?$/.test(compact(ln.text));

  function findDrawingNumber(lines, w, h) {
    const labels = lines.filter((ln) => isDwgLabel(ln, h)).sort((a, b) => b.cy - a.cy);
    for (const lab of labels) {
      const H = lab.height;
      const desc = lines.filter((ln) => compact(ln.text) === "DESCRIPTION" && Math.abs(ln.cy - lab.cy) < H && ln.x0 > lab.x1).map((ln) => ln.x0);
      const right = desc.length ? Math.min(...desc) : lab.x1 + 60 * H;
      let parts = lines.filter((ln) => ln.rot === 0 && ln.cy - lab.cy > 0 && ln.cy - lab.cy < 3 * H && ln.cx > lab.x0 - 3 * H && ln.cx < right);
      if (!parts.length) continue;
      const row = parts.reduce((a, b) => (b.cy < a.cy ? b : a)).cy;
      parts = parts.filter((ln) => Math.abs(ln.cy - row) < 0.6 * H).sort((a, b) => a.x0 - b.x0);
      const text = parts.map((ln) => compact(ln.text)).join("");
      // drawing numbers look like CD-PP1005B-4S-02; anything else is another field
      if (!/^[A-Z]{1,4}-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(text)) continue;
      const m = /^(.+?)-?(\d{1,3})$/.exec(text);
      if (!m) return [text, null];
      return [m[1].replace(/-+$/, ""), parseInt(m[2], 10)];
    }
    return [null, null];
  }

  // --- real text from pdf.js -----------------------------------------------------

  /** Text the PDF stores as real text (TrueType fonts, vendor drawings) as TextLines. */
  function realTextLines(items, vt) {
    const lines = [];
    let cur = null;
    for (const it of items) {
      const t = it.transform;
      const fs = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]);
      const sx = Math.hypot(t[0], t[1]) || 1;
      const dir = [t[0] / sx, t[1] / sx];
      const up = [-dir[1], dir[0]];
      const o = [t[4], t[5]];
      const along = it.width || 0;
      const corners = [];
      for (const a of [0, along]) for (const u of [-0.25, 0.85]) {
        const px = o[0] + dir[0] * a + up[0] * u * fs, py = o[1] + dir[1] * a + up[1] * u * fs;
        corners.push([vt[0] * px + vt[2] * py + vt[4], vt[1] * px + vt[3] * py + vt[5]]);
      }
      const dx = vt[0] * dir[0] + vt[2] * dir[1], dy = vt[1] * dir[0] + vt[3] * dir[1];
      let rot;
      if (Math.abs(dx) >= Math.abs(dy)) rot = dx > 0 ? 0 : 2;
      else rot = dy < 0 ? 1 : 3;
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
      const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const str = it.str || "";
      if (!str.trim()) { if (cur) cur.pendingSpace = true; continue; }
      if (rot === 2) { cur = null; continue; }
      // reading-frame coordinates of the run start/end and baseline
      const start = corners[0], end = corners[2];
      const u0 = rot === 0 ? start[0] : rot === 1 ? -start[1] : start[1];
      const u1 = rot === 0 ? end[0] : rot === 1 ? -end[1] : end[1];
      const base = rot === 0 ? start[1] : start[0];
      if (cur && cur.rot === rot && Math.abs(cur.base - base) < 0.25 * fs && u0 - cur.u1 > -0.5 * fs && u0 - cur.u1 < 1.5 * fs) {
        cur.text += (cur.pendingSpace || u0 - cur.u1 > 0.25 * fs ? " " : "") + str;
        cur.box = [Math.min(cur.box[0], box[0]), Math.min(cur.box[1], box[1]), Math.max(cur.box[2], box[2]), Math.max(cur.box[3], box[3])];
        cur.u1 = u1;
        cur.pendingSpace = false;
      } else {
        cur = { text: str, rot, box, u1, base, fs, pendingSpace: false };
        lines.push(cur);
      }
    }
    return lines.map((l) => {
      const t = l.text.trim();
      const hgt = l.rot === 0 ? l.box[3] - l.box[1] : l.box[2] - l.box[0];
      return new SC.TextLine(t, l.rot, l.box[0], l.box[1], l.box[2], l.box[3], 0.7 * hgt, []);
    }).filter((l) => l.text);
  }

  // --- tags, tokens and cross-references -----------------------------------------

  function tagsIn(text) {
    // device tags are written in capitals; lower-case words ('hysteresis') are not tags
    const t = compact(text).replace(/x/g, "X");
    const out = [];
    TAG.lastIndex = 0;
    let m;
    while ((m = TAG.exec(t))) {
      if (m.index > 0 && isAlnum(t[m.index - 1])) continue;
      const tag = m[1];
      const end = m.index + m[0].length;
      if (end < t.length && t[end] === ".") continue; // terminal reference such as -X3.26
      if (/^\d+$/.test(tag) || tag.length < 2 || NOT_TAGS.has(tag)) continue;
      out.push(tag);
    }
    return out;
  }

  function tokens(text) {
    const out = new Set(tagsIn(text));
    for (let tok of text.toUpperCase().split(/[\s,]+/)) {
      tok = tok.replace(/^[-+()]+|[-+()]+$/g, "");
      if (!tok || /^\d+$/.test(tok) || !/[A-Z]/.test(tok)) continue;
      out.add(tok);
      if (tok.includes(".")) out.add(tok.split(".")[0]); // terminal X3.26 -> strip X3
      if (tok.includes("/")) out.add(tok.split("/")[0]);
      if (tok.length > 2 && tok.endsWith("E")) out.add(tok.slice(0, -1)); // push-button symbol 'E'
    }
    // an O between the letters and the number of a name is a zero (TBO1 -> TB01)
    for (const tok of [...out]) {
      const z = tok.replace(/([A-Z])O(?=\d)/g, "$10");
      if (z !== tok) out.add(z);
    }
    // "-47", "-51-1", "-CPU-I": device names after a dash, digits only or hyphenated
    const re = /(?:^|[^0-9A-Z])-([0-9A-Z]+(?:-[0-9A-Z]+)*)/g;
    const up = compact(text.toUpperCase());
    let m;
    while ((m = re.exec(up))) {
      out.add(m[1]);
      for (let k = m[1].indexOf("-"); k > 0; k = m[1].indexOf("-", k + 1)) out.add(m[1].slice(0, k));
    }
    return out;
  }

  class XRef {
    constructor(sheet, row, col, line, bbox) {
      this.sheet = sheet; this.row = row; this.col = col; this.line = line; this.bbox = bbox;
    }
    toString() { return `/${pad2(this.sheet)}.${this.row}${this.col}`; }
    inZones(sheet, zones) { return this.sheet === sheet && zones.has(zkey(this.row, this.col)); }
  }

  function uncompact(text, k) {
    let n = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== " ") { n++; if (n === k) return i; }
    }
    return text.length - 1;
  }

  function xrefs(ln) {
    const out = [];
    const c = compact(ln.text);
    XREF.lastIndex = 0;
    let m;
    while ((m = XREF.exec(c))) {
      const i0 = uncompact(ln.text, m.index), i1 = uncompact(ln.text, m.index + m[0].length - 1) + 1;
      out.push(new XRef(parseInt(m[1], 10), m[2], parseInt(m[3], 10), ln, ln.charBox(i0, i1)));
    }
    return out;
  }

  const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

  // --- symbol geometry -----------------------------------------------------------

  const r1 = (v) => Math.round(v * 10) / 10;

  function boxes(strokes) {
    const out = [];
    for (const s of strokes) {
      const p = s.pts;
      if (p.length !== 5 && p.length !== 4) continue;
      if (p.length === 5 && (Math.abs(p[0][0] - p[4][0]) > 0.05 || Math.abs(p[0][1] - p[4][1]) > 0.05)) continue;
      const xs = [...new Set(p.map((q) => r1(q[0])))].sort((a, b) => a - b);
      const ys = [...new Set(p.map((q) => r1(q[1])))].sort((a, b) => a - b);
      if (xs.length !== 2 || ys.length !== 2) continue;
      const wd = xs[1] - xs[0], ht = ys[1] - ys[0];
      if (wd > 1.5 && wd < 300 && ht > 1.5 && ht < 200) out.push([xs[0], ys[0], xs[1], ys[1]]);
    }
    return mergeTouching(out);
  }

  function mergeTouching(bx, tol = 0.6) {
    bx = bx.slice();
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < bx.length; i++) {
        for (let j = i + 1; j < bx.length; j++) {
          const a = bx[i], b = bx[j];
          if (a[0] - tol <= b[2] && b[0] - tol <= a[2] && a[1] - tol <= b[3] && b[1] - tol <= a[3]) {
            if (Math.abs((a[3] - a[1]) - (b[3] - b[1])) < 0.35 * Math.max(a[3] - a[1], b[3] - b[1])) {
              bx[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
              bx.splice(j, 1);
              merged = true;
              break outer;
            }
          }
        }
      }
    }
    return bx;
  }

  function attachedBoxes(ln, bx) {
    const H = ln.height;
    return bx.filter((b) => {
      if (b[2] - b[0] < 2 * H && b[3] - b[1] < 2 * H) return false;
      const below = b[1] - ln.y1 > -0.5 * H && b[1] - ln.y1 < 2.5 * H && b[0] - H < ln.cx && ln.cx < b[2] + H;
      const inside = b[0] <= ln.x0 && ln.x1 <= b[2] && b[1] <= ln.y0 && ln.y1 <= b[3] && b[2] - b[0] < 40 * H;
      const beside = Math.abs((b[1] + b[3]) / 2 - ln.cy) < 1.5 * H + (b[3] - b[1]) / 2 && b[0] - ln.x1 >= 0 && b[0] - ln.x1 < 2 * H;
      return below || inside || beside;
    });
  }

  function coilAnchor(ln, bx) {
    const H = ln.height;
    let best = null;
    for (const b of bx) {
      if (b[2] - b[0] > 60 || b[3] - b[1] > 40) continue;
      const bcx = (b[0] + b[2]) / 2, bcy = (b[1] + b[3]) / 2;
      if (Math.abs(bcy - ln.cy) > 1.5 * H + (b[3] - b[1]) / 2) continue;
      let gap, side;
      if (b[0] >= ln.x1 - 0.2 * H) { gap = b[0] - ln.x1; side = 0; }
      else if (b[2] <= ln.x0 + 0.2 * H) { gap = ln.x0 - b[2]; side = 1; }
      else continue;
      if (gap > 3 * H) continue;
      if (!best || side < best.side || (side === best.side && gap < best.gap)) best = { side, gap, c: [bcx, bcy], b };
    }
    if (best) return [best.c, best.b];
    return [[ln.cx, ln.cy], [ln.x0, ln.y0, ln.x1, ln.y1]];
  }

  function contactAnchor(tagLn, refLn, geometry) {
    const H = tagLn.height;
    const x0 = Math.min(tagLn.x0, refLn.x0), x1 = Math.max(tagLn.x1, refLn.x1);
    const y0 = Math.min(tagLn.y0, refLn.y0), y1 = Math.max(tagLn.y1, refLn.y1);
    const cy = (y0 + y1) / 2;
    let best = null;
    for (const st of geometry) {
      if (st.size < 1.5 * H) continue;
      if (st.y1 < y0 - H || st.y0 > y1 + H) continue;
      const sx = (st.x0 + st.x1) / 2;
      let d, side;
      if (x0 - 5 * H < sx && sx < x0) { d = x0 - sx + 3 * H; side = -1; } // labels normally sit left of the contact
      else if (x1 < sx && sx < x1 + 5 * H) { d = sx - x1; side = 1; }
      else continue;
      if (!best || d < best.d) best = { d, sx, side };
    }
    if (!best) return [[(x0 + x1) / 2, cy], [x0, y0, x1, y1]];
    const { sx, side } = best;
    const wx0 = side > 0 ? x1 : x0 - 4 * H, wx1 = side > 0 ? x1 + 4 * H : x0;
    const wy0 = y0 - H, wy1 = y1 + H;
    let bx0 = sx, by0 = cy, bx1 = sx, by1 = cy;
    for (const st of geometry) {
      if (st.x1 < wx0 || st.x0 > wx1 || st.y1 < wy0 || st.y0 > wy1) continue;
      bx0 = Math.min(bx0, Math.max(st.x0, wx0)); bx1 = Math.max(bx1, Math.min(st.x1, wx1));
      by0 = Math.min(by0, Math.max(st.y0, wy0)); by1 = Math.max(by1, Math.min(st.y1, wy1));
    }
    return [[(bx0 + bx1) / 2, cy], [bx0, by0, bx1, by1]];
  }

  function nearTerminals(anchor, tagLn, lines) {
    const H = tagLn.height;
    return lines.filter((ln) => /^\d{1,3}$/.test(compact(ln.text)) && Math.abs(ln.cx - anchor[0]) < 3 * H && Math.abs(ln.cy - anchor[1]) < 6 * H)
      .map((ln) => compact(ln.text));
  }

  function rowTerminals(x, lines) {
    const ln = x.line, H = ln.height;
    const prefix = compact(ln.text);
    let k = prefix.indexOf(`/${x.sheet}`);
    if (k < 0) k = prefix.indexOf("/");
    const head = prefix.slice(0, k);
    let terms = head.match(/[0-9]{1,3}[A-Z]?|[A-Z][0-9]{1,2}/g) || [];
    const cands = [];
    for (const other of lines) {
      if (other === ln || other.rot !== ln.rot || ln.rot !== 0) continue;
      if (Math.abs(other.cy - ln.cy) > 0.5 * H || other.x1 > ln.x0 + 0.1 * H || ln.x0 - other.x1 > 14 * H) continue;
      const t = compact(other.text);
      if (TERM.test(t)) cands.push([other.x0, t]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    terms = cands.map((c) => c[1]).slice(-2).concat(terms);
    return terms.slice(-2);
  }

  function groupRows(rows) {
    rows = rows.slice().sort((a, b) => a.xref.line.cy - b.xref.line.cy || a.xref.line.x0 - b.xref.line.x0);
    const tables = [];
    for (const r of rows) {
      const ln = r.xref.line, H = ln.height;
      const t = tables.find((tb) => {
        const last = tb[tb.length - 1].xref.line;
        return Math.abs(last.x1 - ln.x1) < 3 * H && ln.cy - last.cy > 0 && ln.cy - last.cy < 2.5 * H;
      });
      if (t) t.push(r); else tables.push([r]);
    }
    return tables;
  }

  function parseSchematic(info, strokes) {
    const lines = info.lines;
    const textStrokes = new Set();
    for (const ln of lines) for (const g of ln.glyphs) if (g.atom) for (const s of g.atom.strokes) textStrokes.add(s);
    const geometry = strokes.filter((s) => !textStrokes.has(s));
    const bx = boxes(geometry);

    const tagLines = [];
    for (const ln of lines) {
      for (const tag of tagsIn(ln.text)) {
        if (!info.tags.has(tag)) info.tags.set(tag, []);
        info.tags.get(tag).push(ln);
        tagLines.push([tag, ln]);
      }
      ln.boxes = attachedBoxes(ln, bx);
    }

    const xs = [];
    for (const ln of lines) for (const x of xrefs(ln)) xs.push(x);
    const usedTags = new Set();

    // contact labels: tag with a back-reference right below (or beside) it
    const backrefOf = new Map();
    for (const x of xs) {
      const H = x.line.height;
      let best = null;
      for (const [tag, ln] of tagLines) {
        if (ln === x.line) continue;
        const below = ln.rot === 0 && x.line.y0 - ln.y1 >= 0 && x.line.y0 - ln.y1 < 1.6 * H && overlap(ln.x0, ln.x1, x.line.x0, x.line.x1) > -0.5 * H;
        const vert = ln.rot !== 0 && ln.rot === x.line.rot && Math.abs(ln.cx - x.line.cx) < 2.5 * H && overlap(ln.y0, ln.y1, x.line.y0, x.line.y1) > -H;
        if (below || vert) {
          const d = Math.abs(x.line.cy - ln.cy) + Math.abs(x.line.cx - ln.cx) * 0.2;
          if (!best || d < best[0]) best = [d, tag, ln];
        }
      }
      if (best && !rowTerminals(x, lines).length) backrefOf.set(x, [best[1], best[2]]);
    }

    for (const x of xs) {
      if (!backrefOf.has(x)) continue;
      const [tag, ln] = backrefOf.get(x);
      usedTags.add(ln);
      const [anchor, box] = contactAnchor(ln, x.line, geometry);
      const z = info.zoneOf(anchor[0], anchor[1]);
      if (z) {
        const zones = info.grid.zones(box);
        zones.add(zkey(z.row, z.col));
        info.contacts.push({ tag, page: info.index, line: ln, backref: x, anchor, zone: z, terminals: nearTerminals(anchor, ln, lines), zones });
      }
    }

    // coil tables: rows "a  b  /S.ZN"
    const rows = [];
    for (const x of xs) {
      if (backrefOf.has(x)) continue;
      const terms = rowTerminals(x, lines);
      if (terms.length) rows.push({ terminals: terms, xref: x });
    }
    const coilTags = tagLines.filter(([, ln]) => !usedTags.has(ln));
    for (const table of groupRows(rows)) {
      const tx0 = Math.min(...table.map((r) => r.xref.line.x0));
      const tx1 = Math.max(...table.map((r) => r.xref.line.x1));
      const ty0 = Math.min(...table.map((r) => r.xref.line.y0));
      const H = table[0].xref.line.height;
      let best = null;
      for (const [tag, ln] of coilTags) {
        if (ln.cy > ty0 || ty0 - ln.cy > 45 * H) continue;
        const d = Math.abs(coilAnchor(ln, bx)[0][0] - (tx0 + tx1) / 2) + 0.15 * (ty0 - ln.cy);
        if (!best || d < best[0]) best = [d, tag, ln];
      }
      if (!best) continue;
      const [, tag, ln] = best;
      const [anchor, box] = coilAnchor(ln, bx);
      const z = info.zoneOf(anchor[0], anchor[1]);
      if (!z) continue;
      let coil = info.coils.find((c) => c.line === ln);
      if (!coil) {
        const zones = info.grid.zones(box);
        zones.add(zkey(z.row, z.col));
        coil = { tag, page: info.index, line: ln, anchor, zone: z, rows: [], zones };
        info.coils.push(coil);
      }
      coil.rows.push(...table);
    }
  }

  // --- BOM pages -----------------------------------------------------------------

  function wordBoxes(lines, word) {
    // sub-box of a word inside a real-text line, assuming even character widths
    const out = [];
    for (const ln of lines) {
      if (ln.glyphs.length || ln.rot !== 0) continue;
      const i = ln.text.indexOf(word);
      if (i < 0) continue;
      const n = ln.text.length;
      const w = ln.x1 - ln.x0;
      out.push({ x0: ln.x0 + (w * i) / n, y0: ln.y0, x1: ln.x0 + (w * (i + word.length)) / n, y1: ln.y1 });
    }
    return out;
  }

  /**
   * BOM tables: one row per SHEET label.  A row has its designations, the symbol drawn in
   * the SCHEMATIC DIAGRAM cell, and one or more SHEET cells: when the SHEET row is split
   * by short rules ("07 | 05 | 07") each cell holds the sheets of the symbol part above it.
   */
  function parseBom(info, strokes) {
    const heads = wordBoxes(info.lines, "DESIGNATION");
    for (const ln of info.lines) {
      if (ln.glyphs.length && compact(ln.text) === "DESIGNATION" && !heads.some((r) => Math.abs(ln.x0 - r.x0) < 5)) {
        heads.push({ x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1 });
      }
    }
    const vert = strokes.filter((st) => Math.abs(st.x1 - st.x0) < 0.2);
    const rules = [...new Set(vert.filter((st) => st.y1 - st.y0 > 0.25 * info.height).map((st) => r1(st.x0)))].sort((a, b) => a - b);
    const out = [];
    for (const hd of heads) {
      const cx = (hd.x0 + hd.x1) / 2;
      const left = rules.filter((x) => x < cx), right = rules.filter((x) => x > cx);
      if (!left.length || !right.length) continue;
      const col0 = left[left.length - 1];
      const labels = info.lines.filter((ln) => compact(ln.text) === "SHEET" && ln.y0 > hd.y1 && ln.x0 > hd.x1 - 5 && ln.x0 < hd.x1 + 150 && ln.cy < 0.9 * info.height);
      if (!labels.length) continue;
      const lx = Math.min(...labels.map((ln) => ln.x0));
      const c1 = rules.filter((x) => x > hd.x1 - 2 && x <= lx + 1);
      const col1 = c1.length ? Math.max(...c1) : lx - 1;
      const te = rules.filter((x) => x > lx + 40);
      const tableEnd = te.length ? Math.min(...te) : info.width;
      const sheetLabels = labels.filter((ln) => ln.x0 < lx + 30).sort((a, b) => a.cy - b.cy);
      let prevY = hd.y1;
      for (const lab of sheetLabels) {
        const H = lab.height;
        const desig = info.lines.filter((ln) => ln.cx > col0 && ln.cx < col1 && ln.cy > prevY && ln.cy < lab.y1 && ln.rot === 0);
        const designations = parseDesignations(designationText(desig));
        const nums = info.lines.filter((ln) => ln !== lab && Math.abs(ln.cy - lab.cy) < 0.6 * H && ln.x0 > lab.x1 && ln.x0 < tableEnd);
        // short rules inside the SHEET row split it into cells
        const splits = [...new Set(vert.filter((st) => st.y0 < lab.cy && st.y1 > lab.cy && st.y1 - st.y0 < 4 * H &&
          st.x0 > lab.x1 + 0.5 && st.x0 < tableEnd - 2).map((st) => r1(st.x0)))].sort((a, b) => a - b);
        const bounds = [col1].concat(splits.slice(1), [tableEnd]); // splits[0] closes the "SHEET" label cell
        const cells = [];
        for (let k = 0; k + 1 < bounds.length; k++) {
          const lines = nums.filter((ln) => ln.cx > bounds[k] && ln.cx < bounds[k + 1]);
          const sheets = [...new Set(lines.flatMap((ln) => parseSheetList(ln.text)))].sort((a, b) => a - b);
          if (sheets.length) cells.push({ sheets, lines, x0: bounds[k], x1: bounds[k + 1] });
        }
        if (designations.length) {
          const sheets = [...new Set(cells.flatMap((c) => c.sheets))].sort((a, b) => a - b);
          out.push({
            page: info.index, designations, sheets, cells, desigLines: desig, sheetLines: nums,
            symbolBox: [col1, prevY, tableEnd, lab.y0],
          });
        }
        prevY = lab.y1;
      }
    }
    return out;
  }

  /** The designation cell as one string: rows in reading order, a trailing '-' continues a range. */
  function designationText(lines) {
    if (!lines.length) return "";
    const Hs = lines.map((ln) => ln.height).sort((a, b) => a - b);
    const H = Hs[Math.floor(Hs.length / 2)];
    // drop revision letters in their small triangles and other notes in smaller text
    const keep = lines.filter((ln) => !(compact(ln.text).length <= 1 && ln.height < 0.85 * H));
    keep.sort((a, b) => (Math.abs(a.cy - b.cy) < 0.5 * H ? a.x0 - b.x0 : a.cy - b.cy));
    let text = "";
    for (const ln of keep) {
      const t = ln.text.trim();
      text = !text ? t : /-$/.test(text) ? text + t : `${text}, ${t}`;
    }
    return text;
  }

  function parseSheetList(text) {
    const out = [];
    for (const part of text.replace(/\s*-\s*/g, "-").split(/[,.\s]+/)) {
      const m = /^(\d{1,3})-(\d{1,3})$/.exec(part);
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a <= b && b <= a + 50) for (let k = a; k <= b; k++) out.push(k);
      } else if (/^\d+$/.test(part)) out.push(parseInt(part, 10));
    }
    return out;
  }

  function parseDesignations(text) {
    const t = text.toUpperCase()
      .replace(/\([^)]*\)?/g, " ") // notes such as lamp colours "(G, R, BK)"
      .replace(/\s*-\s*/g, "-"); // "PSU8 - PSU9"
    const out = [];
    for (let part of t.split(/[,.;\s]+/)) {
      part = part.replace(/^-+|-+$/g, "");
      if (!part) continue;
      // ranges: KL1-KL10, TB01-TB03 (zero padding kept), QM1-10
      const m = /^([0-9]*[A-Z][A-Z0-9]*?)(\d+)-([0-9]*[A-Z][A-Z0-9]*?)?(\d+)$/.exec(part);
      if (m && (!m[3] || m[3] === m[1])) {
        const a = parseInt(m[2], 10), b = parseInt(m[4], 10);
        const width = m[2].length === m[4].length ? m[2].length : 0;
        if (a < b && b <= a + 200) {
          for (let k = a; k <= b; k++) out.push(m[1] + String(k).padStart(width, "0"));
          continue;
        }
      }
      // plain names, also numeric device numbers (47, 90) and hyphenated ones (51-1, CPU-I)
      if (/^[0-9A-Z]+(?:-[0-9A-Z]+)*$/.test(part) && (/[A-Z]/.test(part) || /^\d{2,3}(?:-\d{1,2})?$/.test(part))) out.push(part);
    }
    return [...new Set(out)];
  }

  // --- page ----------------------------------------------------------------------

  /**
   * Analyse one page.  `src` = {index, width, height, strokes, textItems, viewportTransform}.
   */
  function analysePage(src, lib) {
    const { index, width: w, height: h, strokes } = src;
    const real = realTextLines(src.textItems || [], src.viewportTransform);
    const lines = SC.readPage(strokes, lib).concat(real);
    const grid = findGrid(lines, w, h, strokes);
    let sheet = findSheetNumber(lines, w, h);
    const [series, dwgNo] = findDrawingNumber(lines, w, h);
    if (sheet === null) sheet = dwgNo;
    const realText = (src.textItems || []).map((it) => it.str).join(" ");
    const texts = lines.map((ln) => ln.text).join(" ");
    let kind;
    if ((realText.includes("DESIGNATION") || texts.includes("DESIGNATION")) && (realText.includes("QTY") || texts.includes("QTY"))) kind = "bom";
    else if (grid.cols.length && grid.rows.length) kind = "schematic";
    else kind = "other";
    const info = {
      index, width: w, height: h, sheet, series, kind, grid, lines,
      // our own title block (vendor drawings bound into the set have their own numbering)
      titled: lines.some((ln) => isDwgLabel(ln, h)),
      coils: [], contacts: [], bomRows: [], tags: new Map(), tokens: new Map(),
      zoneOf(x, y) {
        const z = grid.zone(x, y);
        return z ? { sheet: this.sheet, row: z[0], col: z[1] } : null;
      },
    };
    for (const ln of lines) {
      for (const tok of tokens(ln.text)) {
        if (!info.tokens.has(tok)) info.tokens.set(tok, []);
        info.tokens.get(tok).push(ln);
      }
    }
    // strokes kept compact for the symbol comparison of the BOM check; text is flagged so
    // that terminal numbers do not take part in it
    for (const ln of lines) {
      const many = compact(ln.text).length > 1;
      for (const g of ln.glyphs) if (many || !"|-/.,_·".includes(g.ch)) for (const st of g.atom.strokes) st.text = true;
    }
    if (kind === "bom" || kind === "schematic") info.pack = SC.packSegments(strokes);
    if (kind === "bom") info.bomRows = parseBom(info, strokes);
    else if (kind === "schematic") parseSchematic(info, strokes);
    return info;
  }

  SC.Grid = Grid;
  SC.analysePage = analysePage;
  SC.zkey = zkey;
  SC.pad2 = pad2;
  SC._test = { parseDesignations, parseSheetList, designationText, tagsIn, tokens };
})(typeof globalThis !== "undefined" ? (globalThis.SC = globalThis.SC || {}) : (self.SC = self.SC || {}));
