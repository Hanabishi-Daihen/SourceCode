/* Stroke extraction from a pdf.js page and grouping of touching strokes into atoms.
 *
 * AutoCAD plots SHX text as plain line strokes, so every character on a sheet is a
 * handful of short polylines mixed in with the wiring.  Coordinates are display
 * coordinates: PDF points after page rotation, y pointing down.
 */
(function (SC) {
  "use strict";

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  class Stroke {
    constructor(pts) {
      this.pts = pts; // [[x, y], ...]
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
      this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1;
      this.size = Math.max(x1 - x0, y1 - y0);
    }
  }

  class Atom {
    constructor() {
      this.strokes = [];
      this.x0 = Infinity; this.y0 = Infinity; this.x1 = -Infinity; this.y1 = -Infinity;
    }
    add(s) {
      this.strokes.push(s);
      if (s.x0 < this.x0) this.x0 = s.x0;
      if (s.y0 < this.y0) this.y0 = s.y0;
      if (s.x1 > this.x1) this.x1 = s.x1;
      if (s.y1 > this.y1) this.y1 = s.y1;
    }
    get w() { return this.x1 - this.x0; }
    get h() { return this.y1 - this.y0; }
  }

  // --- pdf.js operator list -> strokes ---------------------------------------

  function mul(m, t) {
    // matrix applying t first, then m (canvas `transform` semantics)
    return [
      m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1],
      m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3],
      m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5],
    ];
  }

  function close(a, b) {
    return Math.abs(a[0] - b[0]) <= 1e-3 && Math.abs(a[1] - b[1]) <= 1e-3;
  }

  /** All stroked polylines of the page in display coordinates. */
  function extractStrokes(opList, viewportTransform, OPS) {
    const out = [];
    let ctm = viewportTransform.slice();
    const stack = [];
    let path = []; // pending subpaths (polylines) of the current path
    let cur = null; // subpath being drawn; pdf.js may split one path over several constructPath ops

    const tf = (x, y) => [round3(ctm[0] * x + ctm[2] * y + ctm[4]), round3(ctm[1] * x + ctm[3] * y + ctm[5])];

    const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke,
      OPS.closeFillStroke, OPS.closeEOFillStroke]);
    const CLOSING = new Set([OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
    const DISCARD = new Set([OPS.fill, OPS.eoFill, OPS.endPath]);

    const fns = opList.fnArray, args = opList.argsArray;
    for (let k = 0; k < fns.length; k++) {
      const fn = fns[k], a = args[k];
      if (fn === OPS.save) {
        stack.push(ctm);
      } else if (fn === OPS.restore) {
        if (stack.length) ctm = stack.pop();
      } else if (fn === OPS.transform) {
        ctm = mul(ctm, a);
      } else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (a && a[0]) ctm = mul(ctm, a[0]);
      } else if (fn === OPS.paintFormXObjectEnd) {
        if (stack.length) ctm = stack.pop();
      } else if (fn === OPS.beginGroup) {
        stack.push(ctm);
        if (a && a[0] && a[0].matrix) ctm = mul(ctm, a[0].matrix);
      } else if (fn === OPS.endGroup) {
        if (stack.length) ctm = stack.pop();
      } else if (fn === OPS.constructPath) {
        const ops = a[0], co = a[1];
        let j = 0;
        for (const op of ops) {
          if (op === OPS.moveTo) {
            cur = { pts: [tf(co[j], co[j + 1])], closed: false };
            path.push(cur);
            j += 2;
          } else if (op === OPS.lineTo) {
            const p = tf(co[j], co[j + 1]);
            j += 2;
            if (!cur) { cur = { pts: [p], closed: false }; path.push(cur); } else cur.pts.push(p);
          } else if (op === OPS.curveTo) {
            const p = tf(co[j + 4], co[j + 5]);
            j += 6;
            if (cur) cur.pts.push(p);
          } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
            const p = tf(co[j + 2], co[j + 3]);
            j += 4;
            if (cur) cur.pts.push(p);
          } else if (op === OPS.closePath) {
            if (cur) {
              cur.closed = true;
              const s = cur.pts[0];
              cur = { pts: [s], closed: false }; // drawing continues from the subpath start
              path.push(cur);
            }
          } else if (op === OPS.rectangle) {
            const x = co[j], y = co[j + 1], w = co[j + 2], h = co[j + 3];
            j += 4;
            const r = [tf(x, y), tf(x + w, y), tf(x + w, y + h), tf(x, y + h)];
            path.push({ pts: r.concat([r[0]]), closed: false, rect: true });
            cur = null;
          }
        }
      } else if (STROKE.has(fn)) {
        const closing = CLOSING.has(fn);
        for (const sp of path) emitSubpath(sp, closing || sp.closed, out);
        path = [];
        cur = null;
      } else if (DISCARD.has(fn)) {
        path = [];
        cur = null;
      }
    }
    return out;
  }

  function emitSubpath(sp, closed, out) {
    let pts = sp.pts;
    if (pts.length < 2) return;
    if (closed && !sp.rect && !close(pts[0], pts[pts.length - 1])) pts = pts.concat([pts[0]]);
    out.push(new Stroke(pts));
  }

  // --- geometry ---------------------------------------------------------------

  function ptSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy;
    if (L === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / L;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }

  function orient(ax, ay, bx, by, cx, cy) {
    const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1;
  }

  function segDist(p, q, r, s) {
    const o1 = orient(p[0], p[1], q[0], q[1], r[0], r[1]);
    const o2 = orient(p[0], p[1], q[0], q[1], s[0], s[1]);
    const o3 = orient(r[0], r[1], s[0], s[1], p[0], p[1]);
    const o4 = orient(r[0], r[1], s[0], s[1], q[0], q[1]);
    if (o1 !== o2 && o3 !== o4 && o1 && o2 && o3 && o4) return 0;
    return Math.min(
      ptSeg(p[0], p[1], r[0], r[1], s[0], s[1]), ptSeg(q[0], q[1], r[0], r[1], s[0], s[1]),
      ptSeg(r[0], r[1], p[0], p[1], q[0], q[1]), ptSeg(s[0], s[1], p[0], p[1], q[0], q[1]));
  }

  function strokesTouch(a, b, tol) {
    if (a.x0 - tol > b.x1 || b.x0 - tol > a.x1 || a.y0 - tol > b.y1 || b.y0 - tol > a.y1) return false;
    const ap = a.pts, bp = b.pts;
    const na = ap.length > 1 ? ap.length - 1 : 1, nb = bp.length > 1 ? bp.length - 1 : 1;
    for (let i = 0; i < na; i++) {
      const p = ap[i], q = ap.length > 1 ? ap[i + 1] : ap[i];
      for (let j = 0; j < nb; j++) {
        const r = bp[j], s = bp.length > 1 ? bp[j + 1] : bp[j];
        if (segDist(p, q, r, s) <= tol) return true;
      }
    }
    return false;
  }

  /** Union touching small strokes into atoms (connected components). */
  function buildAtoms(strokes, maxSize, tol = 0.3) {
    const small = strokes.filter((s) => s.size <= maxSize);
    const n = small.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i) => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    const cell = Math.max(maxSize, 1.0);
    const pad = Math.max(tol, 0.5);
    const grid = new Map();
    small.forEach((s, i) => {
      const gx0 = Math.floor((s.x0 - pad) / cell), gx1 = Math.floor((s.x1 + pad) / cell);
      const gy0 = Math.floor((s.y0 - pad) / cell), gy1 = Math.floor((s.y1 + pad) / cell);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = gx * 100003 + gy;
          let l = grid.get(key);
          if (!l) grid.set(key, (l = []));
          l.push(i);
        }
      }
    });
    const seen = new Set();
    const pairs = [];
    for (const idxs of grid.values()) {
      for (let a = 0; a < idxs.length; a++) {
        for (let b = a + 1; b < idxs.length; b++) {
          let i = idxs[a], j = idxs[b];
          if (i > j) { const t = i; i = j; j = t; }
          const key = i * n + j;
          if (!seen.has(key)) { seen.add(key); pairs.push([i, j]); }
        }
      }
    }
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (const [i, j] of pairs) {
      if (find(i) !== find(j) && strokesTouch(small[i], small[j], tol)) parent[find(i)] = find(j);
    }
    // second pass: larger text has proportionally larger gaps between its strokes
    const box = new Map();
    small.forEach((s, i) => {
      const r = find(i);
      const b = box.get(r);
      if (!b) box.set(r, [s.x0, s.y0, s.x1, s.y1]);
      else { b[0] = Math.min(b[0], s.x0); b[1] = Math.min(b[1], s.y0); b[2] = Math.max(b[2], s.x1); b[3] = Math.max(b[3], s.y1); }
    });
    const gsize = new Map();
    for (const [r, b] of box) gsize.set(r, Math.max(b[2] - b[0], b[3] - b[1]));
    for (const [i, j] of pairs) {
      const ri = find(i), rj = find(j);
      if (ri === rj) continue;
      const t = Math.min(0.6, 0.075 * Math.max(gsize.get(ri) || 0, gsize.get(rj) || 0));
      if (t > tol && strokesTouch(small[i], small[j], t)) parent[ri] = rj;
    }
    const groups = new Map();
    small.forEach((s, i) => {
      const r = find(i);
      let a = groups.get(r);
      if (!a) groups.set(r, (a = new Atom()));
      a.add(s);
    });
    return [...groups.values()];
  }

  SC.Stroke = Stroke;
  SC.Atom = Atom;
  SC.extractStrokes = extractStrokes;
  SC.buildAtoms = buildAtoms;
  SC.matMul = mul;
})(typeof globalThis !== "undefined" ? (globalThis.SC = globalThis.SC || {}) : (self.SC = self.SC || {}));
