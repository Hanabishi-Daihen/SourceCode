/* Shape descriptor for stroke atoms and the glyph template library. */
(function (SC) {
  "use strict";

  const RES = 24;
  const PAD = 2;
  const N = RES * RES;

  /** Rotate polylines of a vertical glyph back to upright (display coords, y down). */
  function rotateUpright(polys, rot) {
    if (rot === 0) return polys;
    let mx = -Infinity, my = -Infinity;
    for (const pl of polys) for (const p of pl) { if (p[0] > mx) mx = p[0]; if (p[1] > my) my = p[1]; }
    if (rot === 1) return polys.map((pl) => pl.map((p) => [my - p[1], p[0]]));
    if (rot === 3) return polys.map((pl) => pl.map((p) => [p[1], mx - p[0]]));
    return polys.map((pl) => pl.map((p) => [mx - p[0], my - p[1]]));
  }

  // Lines are drawn soft (anti-aliased) so that a sub-pixel shift of a stroke, common in
  // narrow glyphs, changes the descriptor only a little.
  const PEN = 0.5; // full intensity within this distance (px) of the stroke
  const SOFT = 0.75; // then fading to zero over this distance

  function plot(img, cx, cy, r) {
    const R = r + SOFT;
    const i0 = Math.max(0, Math.floor(cx - R)), i1 = Math.min(RES - 1, Math.ceil(cx + R));
    const j0 = Math.max(0, Math.floor(cy - R)), j1 = Math.min(RES - 1, Math.ceil(cy + R));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i - cx, j - cy);
      const a = d <= r ? 1 : 1 - (d - r) / SOFT;
      if (a > img[j * RES + i]) img[j * RES + i] = a;
    }
  }

  function line(img, ax, ay, bx, by) {
    const R = PEN + SOFT;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)), i1 = Math.min(RES - 1, Math.ceil(Math.max(ax, bx) + R));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by) - R)), j1 = Math.min(RES - 1, Math.ceil(Math.max(ay, by) + R));
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      let t = L ? ((i - ax) * dx + (j - ay) * dy) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(i - ax - t * dx, j - ay - t * dy);
      const a = d <= PEN ? 1 : 1 - (d - PEN) / SOFT;
      if (a > img[j * RES + i]) img[j * RES + i] = a;
    }
  }

  /** {v: Float32Array unit vector, nz: indices of non-zero entries, w, h, aspect} */
  function descriptor(polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pl of polys) for (const p of pl) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    const w = x1 - x0, h = y1 - y0;
    const s = Math.max(w, h, 1e-6);
    const inner = RES - 2 * PAD;
    const ox = PAD + (inner - (w / s) * inner) / 2;
    const oy = PAD + (inner - (h / s) * inner) / 2;
    const img = new Float32Array(N);
    for (const pl of polys) {
      const pts = pl.map((p) => [ox + ((p[0] - x0) / s) * inner, oy + ((p[1] - y0) / s) * inner]);
      const dot = pts.length === 1 || pts.every((p) => Math.abs(p[0] - pts[0][0]) < 0.3 && Math.abs(p[1] - pts[0][1]) < 0.3);
      if (dot) plot(img, pts[0][0], pts[0][1], 1);
      else for (let k = 0; k + 1 < pts.length; k++) line(img, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
    }
    // small blur for tolerance against quantisation of the plotter coordinates
    const b = img.slice();
    for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
      const a = img[j * RES + i];
      if (a <= 0) continue;
      if (j + 1 < RES) b[(j + 1) * RES + i] += 0.5 * a;
      if (j > 0) b[(j - 1) * RES + i] += 0.5 * a;
      if (i + 1 < RES) b[j * RES + i + 1] += 0.5 * a;
      if (i > 0) b[j * RES + i - 1] += 0.5 * a;
    }
    let n2 = 0;
    for (let k = 0; k < N; k++) n2 += b[k] * b[k];
    const norm = Math.sqrt(n2);
    const nz = [];
    if (norm > 0) for (let k = 0; k < N; k++) if (b[k]) { b[k] /= norm; nz.push(k); }
    return { v: b, nz: Int16Array.from(nz), w, h, aspect: (w + 0.05 * s) / (h + 0.05 * s) };
  }

  /** P and R differ only by R's leg reaching the bottom-right corner. */
  function pOrR(polys, rot) {
    const up = rotateUpright(polys, rot);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pl of up) for (const p of pl) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    const w = Math.max(x1 - x0, 1e-6), h = Math.max(y1 - y0, 1e-6);
    for (const pl of up) {
      const segs = pl.length > 1 ? pl.length - 1 : 1;
      for (let k = 0; k < segs; k++) {
        const a = pl[k], b = pl.length > 1 ? pl[k + 1] : pl[k];
        for (const t of [0, 0.5, 1]) {
          const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
          if ((px - x0) / w > 0.55 && (py - y0) / h > 0.85) return "R";
        }
      }
    }
    return "P";
  }

  /**
   * Template library.  `data` is [[ch|null, rot, [[x, y, x, y, ...], ...]], ...] with
   * coordinates quantised to integers (see build.mjs).
   */
  class TemplateLibrary {
    constructor(data, { dropJunk = false } = {}) {
      let entries = data.map(([ch, rot, polys]) => ({
        ch, rot, polys: polys.map((flat) => { const pl = []; for (let i = 0; i < flat.length; i += 2) pl.push([flat[i], flat[i + 1]]); return pl; }),
      }));
      for (const e of entries) {
        const d = descriptor(e.polys);
        e.v = d.v; e.nz = d.nz; e.logA = Math.log(d.aspect);
      }
      if (dropJunk) entries = dropConflictingJunk(entries);
      // sorted by aspect so a lookup only scans templates that could still win
      entries.sort((a, b) => a.logA - b.logA);
      this.entries = entries;
      this.logA = Float64Array.from(entries.map((e) => e.logA));
    }

    /**
     * Best template for the polylines: {ch, rot, score}; score < minScore means no match.
     * A character template wins over a non-text template that is only marginally closer.
     */
    classify(polys, minScore = 0.8, margin = 0.04) {
      const d = descriptor(polys);
      const la = Math.log(d.aspect);
      const E = this.entries, L = this.logA, n = E.length;
      // binary search for the closest aspect, then widen in both directions
      let lo = 0, hi = n;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (L[mid] < la) lo = mid + 1; else hi = mid; }
      let l = lo - 1, r = lo;
      let bestText = -Infinity, textK = -1, bestJunk = -Infinity;
      const v = d.v, nz = d.nz;
      while (l >= 0 || r < n) {
        const dl = l >= 0 ? la - L[l] : Infinity;
        const dr = r < n ? L[r] - la : Infinity;
        const k = dl <= dr ? l-- : r++;
        const pen = 0.5 * Math.min(dl, dr);
        // cosine similarity is at most 1, so nothing further out can beat this
        const best = Math.max(bestText, bestJunk - margin);
        if (1 - pen < Math.max(best, minScore - 0.05)) break;
        const tv = E[k].v;
        let dot = 0;
        for (let q = 0; q < nz.length; q++) dot += v[nz[q]] * tv[nz[q]];
        const s = dot - pen;
        if (E[k].ch === null) { if (s > bestJunk) bestJunk = s; }
        else if (s > bestText) { bestText = s; textK = k; }
      }
      if (textK < 0 || bestText < bestJunk - margin) return { ch: null, rot: 0, score: bestJunk };
      let { ch, rot } = E[textK];
      if (ch === "P" || ch === "R") ch = pOrR(polys, rot);
      return { ch, rot, score: bestText };
    }
  }

  /** Junk templates that look just like a character would swallow that character. */
  function dropConflictingJunk(entries, thr = 0.92) {
    const text = entries.filter((e) => e.ch !== null);
    return entries.filter((e) => {
      if (e.ch !== null) return true;
      for (const t of text) {
        const pen = 0.5 * Math.abs(t.logA - e.logA);
        if (1 - pen < thr) continue;
        let dot = 0;
        for (let q = 0; q < e.nz.length; q++) dot += e.v[e.nz[q]] * t.v[e.nz[q]];
        if (dot - pen >= thr) return false;
      }
      return true;
    });
  }

  SC.descriptor = descriptor;
  SC.rotateUpright = rotateUpright;
  SC.TemplateLibrary = TemplateLibrary;
})(typeof globalThis !== "undefined" ? (globalThis.SC = globalThis.SC || {}) : (self.SC = self.SC || {}));
