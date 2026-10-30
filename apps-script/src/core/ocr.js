/* Read SHX stroke text: atoms -> glyph classification -> text lines.
 *
 * Reading directions (rot): 0 left-to-right, 1 vertical bottom-to-top (glyphs rotated
 * 90deg CCW), 3 vertical top-to-bottom (glyphs rotated 90deg CW).
 */
(function (SC) {
  "use strict";

  const MIN_SCORE = 0.8;
  const MAX_GLYPH = 10.0; // pt; anything larger is drawing geometry, not text
  const DOT = 0.35; // pt; atoms smaller than this in both directions are dots
  const NEUTRAL = new Set(["|", "-", "/", "X", "x", "+", "."]);
  const BRIDGE = new Set(["X", "x", "+"]);
  const SAME_CASE = new Set([..."cosuvwxz"]);
  // look the same turned upside down, so a vertical one can come out in either direction
  const SYM180 = new Set([..."0OoHINSZXxsz8"]);

  class TextLine {
    constructor(text, rot, x0, y0, x1, y1, height, glyphs) {
      this.text = text; this.rot = rot;
      this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1;
      this.height = height;
      this.glyphs = glyphs || [];
      this.boxes = []; // device symbol boxes this text labels
    }
    get cx() { return (this.x0 + this.x1) / 2; }
    get cy() { return (this.y0 + this.y1) / 2; }

    /** Bounding box of characters i..j-1 of `text` (spaces skipped). */
    charBox(i, j) {
      if (!this.glyphs.length) return [this.x0, this.y0, this.x1, this.y1];
      const per = [];
      let k = 0;
      for (const ch of this.text) per.push(ch === " " ? null : this.glyphs[k++]);
      const gs = per.slice(i, j).filter(Boolean);
      if (!gs.length) return [this.x0, this.y0, this.x1, this.y1];
      return [Math.min(...gs.map((g) => g.x0)), Math.min(...gs.map((g) => g.y0)),
        Math.max(...gs.map((g) => g.x1)), Math.max(...gs.map((g) => g.y1))];
    }
  }

  function frame(g, rot) {
    if (rot === 0) return [g.x0, g.y0, g.x1, g.y1];
    if (rot === 1) return [-g.y1, g.x0, -g.y0, g.x1];
    return [g.y0, -g.x1, g.y1, -g.x0];
  }

  function neutralChar(ch, rot) {
    if (rot === 0) return ch;
    return ch === "|" ? "-" : ch === "-" ? "|" : ch;
  }

  function classifyPage(strokes, lib) {
    const glyphs = [];
    for (const at of SC.buildAtoms(strokes, 12)) {
      if (at.w <= DOT && at.h <= DOT) {
        glyphs.push({ atom: at, ch: ".", rot: 0, score: 1, x0: at.x0, y0: at.y0, x1: at.x1, y1: at.y1 });
        continue;
      }
      if (Math.max(at.w, at.h) > MAX_GLYPH || at.strokes.length > 25) continue;
      const polys = at.strokes.map((s) => s.pts.map((p) => [p[0] - at.x0, p[1] - at.y0]));
      const r = lib.classify(polys, MIN_SCORE);
      if (r.ch === null || r.score < MIN_SCORE) continue;
      glyphs.push({ atom: at, ch: r.ch, rot: r.rot, score: r.score, x0: at.x0, y0: at.y0, x1: at.x1, y1: at.y1 });
    }
    return glyphs;
  }

  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  function linesFor(glyphs, rot, taken, fb) {
    const core = new Set();
    glyphs.forEach((g, i) => { if (!taken.has(i) && g.rot === rot && !NEUTRAL.has(g.ch)) core.add(i); });
    if (!core.size) return [];
    // symmetric characters may bridge two parts of a line, but never start one on their own
    const seedSet = new Set(core);
    glyphs.forEach((g, i) => {
      if (taken.has(i)) return;
      if (BRIDGE.has(g.ch) && (g.rot === 0 || g.rot === rot)) seedSet.add(i);
      else if (rot !== 0 && SYM180.has(g.ch) && g.rot === 4 - rot) seedSet.add(i);
    });
    const seeds = [...seedSet];
    const parent = new Map(seeds.map((i) => [i, i]));
    const find = (i) => {
      while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); }
      return i;
    };
    seeds.sort((a, b) => fb[a][0] - fb[b][0]);
    for (let ai = 0; ai < seeds.length; ai++) {
      const a = seeds[ai];
      const [, av0, au1, av1] = fb[a];
      const ha = av1 - av0;
      for (let bi = ai + 1; bi < seeds.length; bi++) {
        const b = seeds[bi];
        const [bu0, bv0, , bv1] = fb[b];
        const hb = bv1 - bv0;
        const h = Math.max(ha, hb);
        if (bu0 - au1 > 1.2 * h) break;
        if (Math.min(ha, hb) < 0.55 * h) continue;
        const ov = Math.min(av1, bv1) - Math.max(av0, bv0);
        if (ov < 0.6 * Math.min(ha, hb)) continue;
        parent.set(find(a), find(b));
      }
    }
    const groups = new Map();
    for (const i of seeds) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(i);
    }
    const lines = [];
    for (const members of groups.values()) {
      if (!members.some((i) => core.has(i))) continue;
      const H = median(members.filter((i) => core.has(i)).map((i) => fb[i][3] - fb[i][1]));
      lines.push({ members, H });
    }
    return lines;
  }

  function attachNeutrals(glyphs, lines, taken, fb) {
    for (const { members, H } of lines) {
      const inLine = new Set(members);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const i of members) {
        u0 = Math.min(u0, fb[i][0]); u1 = Math.max(u1, fb[i][2]);
        v0 = Math.min(v0, fb[i][1]); v1 = Math.max(v1, fb[i][3]);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < glyphs.length; i++) {
          if (taken.has(i) || !NEUTRAL.has(glyphs[i].ch) || inLine.has(i)) continue;
          const [gu0, gv0, gu1, gv1] = fb[i];
          if (gu1 < u0 - H || gu0 > u1 + H) continue;
          if (gv1 - gv0 > 1.25 * H || gv0 < v0 - 0.25 * H || gv1 > v1 + 0.25 * H) continue;
          if (gu1 - gu0 > 1.5 * H) continue;
          members.push(i); inLine.add(i); taken.add(i);
          u0 = Math.min(u0, gu0); u1 = Math.max(u1, gu1);
          changed = true;
        }
      }
    }
  }

  function lineText(glyphs, members, H, rot) {
    const fb = {};
    for (const i of members) fb[i] = frame(glyphs[i], rot);
    members = members.slice().sort((a, b) => (fb[a][0] + fb[a][2]) / 2 - (fb[b][0] + fb[b][2]) / 2);
    const vs = members.filter((i) => !NEUTRAL.has(glyphs[i].ch)).map((i) => fb[i]);
    const base = vs.length ? median(vs.map((v) => v[3])) : Math.max(...members.map((i) => fb[i][3]));
    const top = vs.length ? median(vs.map((v) => v[1])) : Math.min(...members.map((i) => fb[i][1]));
    const out = [], gl = [];
    let prevU1 = null, prevW = null;
    for (const i of members) {
      const g = glyphs[i];
      const [u0, v0, u1, v1] = fb[i];
      let ch = g.rot !== rot || NEUTRAL.has(g.ch) ? neutralChar(g.ch, rot) : g.ch;
      const w = u1 - u0, h = v1 - v0;
      if ((ch === "|" || ch === "-" || ch === "/") && w < 0.3 * H && h < 0.3 * H) ch = ch === "/" && v1 > base - 0.05 * H && h > 0.12 * H ? "," : ".";
      // a bar reaching above and below the capitals is a bracket ("(G, R)" in this font)
      if (ch === "|" && h > 1.1 * H && v0 < top - 0.04 * H && v1 > base + 0.04 * H) ch = "\u0001";
      if (ch === "|" || ch === "-") {
        if (h >= 0.6 * H && w < 0.3 * H) ch = "|";
        else if (h < 0.25 * H) ch = (v0 + v1) / 2 > base - 0.15 * H ? "_" : "-";
      }
      if (ch === "." && (v0 + v1) / 2 < top + 0.6 * (base - top)) ch = "·";
      // letters drawn the same in both cases: the height decides
      if (SAME_CASE.has(ch.toLowerCase())) ch = h >= 0.8 * H ? ch.toUpperCase() : h < 0.72 * H ? ch.toLowerCase() : ch;
      if (prevU1 !== null) {
        // narrow glyphs such as '1' sit centred in a wider cell: discount that slack
        const slack = 0.5 * Math.max(0, 0.5 * H - w) + 0.5 * Math.max(0, 0.5 * H - prevW);
        if (u0 - prevU1 - slack > 0.55 * H) out.push(" ");
      }
      out.push(ch);
      gl.push(g);
      prevU1 = prevU1 === null ? u1 : Math.max(prevU1, u1);
      prevW = w;
    }
    const text = fixDigits(fixBars(brackets(out.join(""))));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of members) {
      const g = glyphs[i];
      x0 = Math.min(x0, g.x0); y0 = Math.min(y0, g.y0); x1 = Math.max(x1, g.x1); y1 = Math.max(y1, g.y1);
    }
    return new TextLine(text, rot, x0, y0, x1, y1, H, gl);
  }

  const isAlpha = (c) => /\p{L}/u.test(c);

  /** Tall bars marked as brackets open before a word and close after one. */
  function brackets(text) {
    const c = [...text];
    for (let k = 0; k < c.length; k++) {
      if (c[k] !== "\u0001") continue;
      const prev = k ? c[k - 1] : " ", nxt = k + 1 < c.length ? c[k + 1] : " ";
      const word = (ch) => /[\p{L}\p{N}]/u.test(ch);
      c[k] = word(nxt) && !word(prev) ? "(" : word(prev) && !word(nxt) ? ")" : "|";
    }
    return c.join("");
  }
  const isDigit = (c) => c >= "0" && c <= "9";

  /** A bare vertical bar is '1' among digits and 'I' before letters. */
  function fixBars(text) {
    const chars = [...text];
    for (let k = 0; k < chars.length; k++) {
      if (chars[k] !== "|") continue;
      const prev = k ? chars[k - 1] : "";
      const nxt = k + 1 < chars.length ? chars[k + 1] : "";
      if (nxt && isAlpha(nxt)) chars[k] = "I";
      else if (prev && isAlpha(prev) && nxt && !isDigit(nxt) && !"./".includes(nxt)) chars[k] = "I";
      else chars[k] = "1";
    }
    return chars.join("");
  }

  /** 0/O and 1/I look alike in several fonts: neighbouring characters decide. */
  function fixDigits(text) {
    const c = [...text];
    for (let k = 0; k < c.length; k++) {
      const prev = k ? c[k - 1] : "", nxt = k + 1 < c.length ? c[k + 1] : "";
      const letterAround = (prev && isAlpha(prev)) || (nxt && isAlpha(nxt));
      const digitAround = (prev && isDigit(prev)) || (nxt && isDigit(nxt));
      if (c[k] === "0" && prev && nxt && isAlpha(prev) && isAlpha(nxt)) c[k] = "O";
      else if ((c[k] === "O" || c[k] === "o") && digitAround && !letterAround) c[k] = "0";
      else if ((c[k] === "I" || c[k] === "l") && digitAround && !letterAround) c[k] = "1";
    }
    return c.join("");
  }

  function readPage(strokes, lib) {
    const glyphs = classifyPage(strokes, lib);
    const taken = new Set();
    const all = [];
    for (const rot of [0, 1, 3]) {
      const fb = glyphs.map((g) => frame(g, rot));
      const lines = linesFor(glyphs, rot, taken, fb);
      for (const l of lines) for (const i of l.members) taken.add(i);
      attachNeutrals(glyphs, lines, taken, fb);
      for (const l of lines) all.push({ members: l.members, H: l.H, rot });
    }
    // leftover vertical bars that are text on their own (terminal "1")
    glyphs.forEach((g, i) => {
      if (taken.has(i) || g.ch !== "|") return;
      const h = g.y1 - g.y0;
      if (h >= 1.2 && h <= MAX_GLYPH) { all.push({ members: [i], H: h, rot: 0 }); taken.add(i); }
    });
    return mergeSplitLines(all.map((l) => lineText(glyphs, l.members, l.H, l.rot)));
  }

  /** Re-join cross-references split at the slash ('2 /' + '05.E1' -> '2 /05.E1'). */
  function mergeSplitLines(lines) {
    lines = lines.filter((ln) => ln.text.trim());
    const used = new Set();
    const out = [];
    for (const a of lines) {
      if (used.has(a)) continue;
      let cur = a;
      while (cur.text.trimEnd().endsWith("/")) {
        let nxt = null;
        for (const b of lines) {
          if (b === cur || used.has(b) || b.rot !== cur.rot || !isDigit(b.text[0] || "")) continue;
          let gap, dv;
          if (cur.rot === 0) { gap = b.x0 - cur.x1; dv = Math.abs(b.cy - cur.cy); }
          else if (cur.rot === 1) { gap = cur.y0 - b.y1; dv = Math.abs(b.cx - cur.cx); }
          else { gap = b.y0 - cur.y1; dv = Math.abs(b.cx - cur.cx); }
          if (gap > -0.2 * cur.height && gap < 1.5 * cur.height && dv < 0.35 * cur.height) { nxt = b; break; }
        }
        if (!nxt) break;
        used.add(nxt);
        cur = new TextLine(cur.text.trimEnd() + nxt.text, cur.rot, Math.min(cur.x0, nxt.x0), Math.min(cur.y0, nxt.y0),
          Math.max(cur.x1, nxt.x1), Math.max(cur.y1, nxt.y1), cur.height, cur.glyphs.concat(nxt.glyphs));
      }
      out.push(cur);
    }
    return out;
  }

  SC.TextLine = TextLine;
  SC.readPage = readPage;
  SC.fixBars = fixBars;
  SC.fixDigits = fixDigits;
})(typeof globalThis !== "undefined" ? (globalThis.SC = globalThis.SC || {}) : (self.SC = self.SC || {}));
