/* Symbol comparison: is the symbol drawn in a BOM row the one drawn next to the device?
 *
 * The BOM shows each device's symbol, usually the same block as on the schematic but
 * inserted at another scale.  A part of the BOM drawing (a breaker body, a coil, a
 * contact) is located near the device tag by pairing its long strokes with strokes of
 * the same direction there, which fixes scale and offset; each such placement is scored
 * by the share of the part's outline that lands on schematic strokes.
 */
(function (SC) {
  "use strict";

  const CELL = 24; // pt, segment index cell
  const STEP = 0.5; // pt, spacing of the sample points along the part's strokes
  const RES = 2; // px per pt of the schematic raster used for scoring

  /** Page strokes as a flat segment list (text strokes flagged) with a coarse grid index. */
  function packSegments(strokes) {
    let n = 0;
    for (const s of strokes) n += Math.max(1, s.pts.length - 1);
    const segs = new Float32Array(4 * n);
    const text = new Uint8Array(n);
    let k = 0;
    for (const s of strokes) {
      const p = s.pts;
      const t = s.text ? 1 : 0;
      if (p.length === 1) { text[k / 4] = t; segs.set([p[0][0], p[0][1], p[0][0], p[0][1]], k); k += 4; continue; }
      for (let i = 0; i + 1 < p.length; i++) {
        text[k / 4] = t;
        segs[k++] = p[i][0]; segs[k++] = p[i][1]; segs[k++] = p[i + 1][0]; segs[k++] = p[i + 1][1];
      }
    }
    return { segs, text, grid: null };
  }

  function buildGrid(pack) {
    const grid = new Map();
    const s = pack.segs;
    for (let i = 0; i < s.length; i += 4) {
      const gx0 = Math.floor(Math.min(s[i], s[i + 2]) / CELL), gx1 = Math.floor(Math.max(s[i], s[i + 2]) / CELL);
      const gy0 = Math.floor(Math.min(s[i + 1], s[i + 3]) / CELL), gy1 = Math.floor(Math.max(s[i + 1], s[i + 3]) / CELL);
      if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 400) continue; // page border: never part of a symbol
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
        const key = gx * 4096 + gy;
        let l = grid.get(key);
        if (!l) grid.set(key, (l = []));
        l.push(i);
      }
    }
    pack.grid = grid;
  }

  /** Offsets of the segments that touch the box (or lie inside it when `inside`). */
  function segsIn(pack, [x0, y0, x1, y1], inside) {
    if (!pack.grid) buildGrid(pack);
    const s = pack.segs, out = new Set();
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
      for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        for (const i of pack.grid.get(gx * 4096 + gy) || []) {
          const a0 = Math.min(s[i], s[i + 2]), a1 = Math.max(s[i], s[i + 2]);
          const b0 = Math.min(s[i + 1], s[i + 3]), b1 = Math.max(s[i + 1], s[i + 3]);
          if (inside ? a0 >= x0 && a1 <= x1 && b0 >= y0 && b1 <= y1 : a1 >= x0 && a0 <= x1 && b1 >= y0 && b0 <= y1) out.add(i);
        }
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  const len = (s, i) => Math.hypot(s[i + 2] - s[i], s[i + 3] - s[i + 1]);

  function boxOf(s, g) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of g) {
      x0 = Math.min(x0, s[i], s[i + 2]); x1 = Math.max(x1, s[i], s[i + 2]);
      y0 = Math.min(y0, s[i + 1], s[i + 3]); y1 = Math.max(y1, s[i + 1], s[i + 3]);
    }
    return [x0, y0, x1, y1];
  }

  function ptSeg(px, py, s, i) {
    const ax = s[i], ay = s[i + 1], dx = s[i + 2] - ax, dy = s[i + 3] - ay;
    const L = dx * dx + dy * dy;
    let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }

  function segsTouch(s, i, j, tol) {
    if (Math.min(s[i], s[i + 2]) - tol > Math.max(s[j], s[j + 2]) || Math.min(s[j], s[j + 2]) - tol > Math.max(s[i], s[i + 2]) ||
      Math.min(s[i + 1], s[i + 3]) - tol > Math.max(s[j + 1], s[j + 3]) || Math.min(s[j + 1], s[j + 3]) - tol > Math.max(s[i + 1], s[i + 3])) return false;
    return Math.min(ptSeg(s[i], s[i + 1], s, j), ptSeg(s[i + 2], s[i + 3], s, j),
      ptSeg(s[j], s[j + 1], s, i), ptSeg(s[j + 2], s[j + 3], s, i)) <= tol;
  }

  /**
   * The symbol in a BOM row's SCHEMATIC DIAGRAM cell, split into its separately drawn
   * parts (a breaker body with its poles, an auxiliary contact, a coil ...), largest
   * first.  Text and the dashes of mechanical links are left out.
   */
  function symbolParts(pack, box) {
    const [x0, y0, x1, y1] = box;
    const s = pack.segs;
    const idx = segsIn(pack, [x0 + 1, y0 + 1, x1 - 1, y1 - 1], true).filter((i) => !pack.text[i / 4]);
    const n = idx.length;
    if (!n) return [];
    const parent = idx.map((_, k) => k);
    const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      if (find(a) !== find(b) && segsTouch(s, idx[a], idx[b], 0.3)) parent[find(a)] = find(b);
    }
    const groups = new Map();
    idx.forEach((i, k) => { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
    const parts = [];
    for (const g of groups.values()) {
      const b = boxOf(s, g);
      const total = g.reduce((a, i) => a + len(s, i), 0);
      if (Math.max(b[2] - b[0], b[3] - b[1]) < 4 || total < 10) continue; // dashes, dots
      parts.push({ segs: g, box: b, length: total });
    }
    return parts.sort((a, b) => b.length - a.length);
  }

  // --- matching ------------------------------------------------------------------

  /**
   * The part turned by (rot % 4) x 90 degrees clockwise, mirrored first when rot >= 4
   * (display coordinates): its outline as sample points and its longest strokes as
   * anchors, relative to the turned box corner.
   */
  function turned(s, part, rot) {
    part.turned = part.turned || [];
    if (part.turned[rot]) return part.turned[rot];
    const W = part.box[2] - part.box[0], H = part.box[3] - part.box[1];
    const r = rot % 4;
    const T = (x, y) => {
      x -= part.box[0]; y -= part.box[1];
      if (rot >= 4) x = W - x;
      return r === 0 ? [x, y] : r === 1 ? [H - y, x] : r === 2 ? [W - x, H - y] : [y, W - x];
    };
    const xs = [], ys = [];
    for (const i of part.segs) {
      const n = Math.max(1, Math.round(len(s, i) / STEP));
      for (let t = 0; t <= n; t++) {
        const [x, y] = T(s[i] + ((s[i + 2] - s[i]) * t) / n, s[i + 1] + ((s[i + 3] - s[i + 1]) * t) / n);
        xs.push(x); ys.push(y);
      }
    }
    const anchors = part.segs.slice().sort((a, b) => len(s, b) - len(s, a)).slice(0, 4).map((i) => {
      const p = T(s[i], s[i + 1]), q = T(s[i + 2], s[i + 3]);
      return norm(p[0], p[1], q[0], q[1]);
    });
    // every 4th point for the first pass over the candidate placements
    const sub = (arr) => arr.filter((_, k) => k % 4 === 0);
    const out = {
      xs: Float32Array.from(xs), ys: Float32Array.from(ys), sx: Float32Array.from(sub(xs)), sy: Float32Array.from(sub(ys)),
      anchors, w: r % 2 ? H : W, h: r % 2 ? W : H,
    };
    part.turned[rot] = out;
    return out;
  }

  /** A segment with its direction made unique (left to right, or downwards when vertical). */
  function norm(x0, y0, x1, y1) {
    if (x1 < x0 - 1e-6 || (Math.abs(x1 - x0) <= 1e-6 && y1 < y0)) return [x1, y1, x0, y0];
    return [x0, y0, x1, y1];
  }

  /** Page strokes rasterised once, with one pixel of slack, for the scoring. */
  function pageRaster(pack) {
    if (pack.raster) return pack.raster;
    const s = pack.segs;
    let W = 0, H = 0;
    for (let i = 0; i < s.length; i += 4) { W = Math.max(W, s[i], s[i + 2]); H = Math.max(H, s[i + 1], s[i + 3]); }
    W = Math.ceil(W * RES) + 2; H = Math.ceil(H * RES) + 2;
    const img = new Uint8Array(W * H);
    for (let i = 0; i < s.length; i += 4) {
      const ax = s[i] * RES, ay = s[i + 1] * RES, bx = s[i + 2] * RES, by = s[i + 3] * RES;
      const steps = Math.max(1, Math.ceil(2 * Math.hypot(bx - ax, by - ay)));
      for (let t = 0; t <= steps; t++) {
        const x = Math.round(ax + ((bx - ax) * t) / steps), y = Math.round(ay + ((by - ay) * t) / steps);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Y = y + dy;
          if (X >= 0 && Y >= 0 && X < W && Y < H) img[Y * W + X] = 1;
        }
      }
    }
    pack.raster = { img, W, H };
    return pack.raster;
  }

  function score(xs, ys, R, k, tx, ty) {
    const { img, W, H } = R;
    let hit = 0;
    const n = xs.length;
    for (let q = 0; q < n; q++) {
      const X = Math.round((xs[q] * k + tx) * RES), Y = Math.round((ys[q] * k + ty) * RES);
      if (X >= 0 && Y >= 0 && X < W && Y < H && img[Y * W + X]) hit++;
    }
    return hit / n;
  }

  /**
   * Best placement of a BOM part in the window of a schematic page:
   * {score, k (scale), rot, box}.  Turns by 90 degrees, mirror images (a contact block
   * drawn the other way round is still the same device) and scales kMin..kMax are tried.
   */
  function matchPart(part, bomPack, pack, win, kMin = 0.6, kMax = 2.2) {
    const s0 = bomPack.segs, s1 = pack.segs;
    const idx = segsIn(pack, win, false);
    if (!idx.length) return { score: 0, k: 1, rot: 0, box: null };
    const R = pageRaster(pack);
    const segB = idx.map((b) => norm(s1[b], s1[b + 1], s1[b + 2], s1[b + 3]));
    const cands = [];
    const tried = new Set();
    for (let rot = 0; rot < 8; rot++) {
      const P = turned(s0, part, rot);
      for (const [ax0, ay0, ax1, ay1] of P.anchors) {
        const ax = ax1 - ax0, ay = ay1 - ay0, La = Math.hypot(ax, ay);
        if (La < 2) continue;
        for (const [bx0, by0, bx1, by1] of segB) {
          const bx = bx1 - bx0, by = by1 - by0, Lb = Math.hypot(bx, by);
          const k = Lb / La;
          if (k < kMin || k > kMax) continue;
          if (Math.abs(ax * by - ay * bx) > 0.03 * La * Lb || ax * bx + ay * by <= 0) continue; // not parallel
          const tx = bx0 - ax0 * k, ty = by0 - ay0 * k;
          const key = `${rot}|${Math.round(k * 50)}|${Math.round(tx * 2)}|${Math.round(ty * 2)}`;
          if (tried.has(key)) continue;
          tried.add(key);
          cands.push([score(P.sx, P.sy, R, k, tx, ty), rot, k, tx, ty]);
        }
      }
    }
    if (!cands.length) return { score: 0, k: 1, rot: 0, box: null };
    cands.sort((a, b) => b[0] - a[0]);
    let best = { score: 0, rot: 0, k: 1, tx: 0, ty: 0 };
    for (const [, rot, k, tx, ty] of cands.slice(0, 6)) {
      const P = turned(s0, part, rot);
      let cur = { score: score(P.xs, P.ys, R, k, tx, ty), rot, k, tx, ty };
      // polish: small changes of scale and offset
      for (let round = 0; round < 2; round++) {
        const base = cur;
        for (const dk of [-0.02, -0.01, 0, 0.01, 0.02]) {
          for (const dx of [-0.5, 0, 0.5]) for (const dy of [-0.5, 0, 0.5]) {
            const k2 = base.k * (1 + dk);
            const sc = score(P.xs, P.ys, R, k2, base.tx + dx, base.ty + dy);
            if (sc > cur.score) cur = { score: sc, rot, k: k2, tx: base.tx + dx, ty: base.ty + dy };
          }
        }
      }
      if (cur.score > best.score) best = cur;
    }
    const P = turned(s0, part, best.rot);
    return { score: best.score, k: best.k, rot: best.rot, box: [best.tx, best.ty, best.tx + P.w * best.k, best.ty + P.h * best.k] };
  }

  /** Drop the page raster (it is only needed while that page is being compared). */
  function release(pack) { pack.raster = null; }

  SC.packSegments = packSegments;
  SC.symbolParts = symbolParts;
  SC.matchPart = matchPart;
  SC.segsIn = segsIn;
  SC.releaseRaster = release;
})(typeof globalThis !== "undefined" ? (globalThis.SC = globalThis.SC || {}) : (self.SC = self.SC || {}));
