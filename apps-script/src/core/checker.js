/* Cross-sheet checks: coil contact tables, contact back-references and BOM sheet lists. */
(function (SC) {
  "use strict";

  const pad2 = (n) => String(n).padStart(2, "0");
  const compact = (s) => s.replace(/ /g, "");
  const bb = (ln, p = 1) => [ln.x0 - p, ln.y0 - p, ln.x1 + p, ln.y1 + p];
  const xb = (x, p = 1) => [x.bbox[0] - p, x.bbox[1] - p, x.bbox[2] + p, x.bbox[3] + p];
  const mark = (page, bbox) => ({ page, bbox });
  const zs = (z) => (z && z.sheet !== null && z.sheet !== undefined ? `/${pad2(z.sheet)}.${z.row}${z.col}` : z ? `?.${z.row}${z.col}` : "?");

  function finding(severity, code, message, fix, page, sheet, marks) {
    return { severity, code, message, fix, page, sheet: sheet === undefined ? null : sheet, marks };
  }

  /** Pages whose drawing number could not be read take the series of their neighbours. */
  function inferSeries(pages) {
    pages.forEach((p, i) => {
      if (p.series !== null || p.sheet === null || p.titled === false) return;
      let prev = null, nxt = null;
      for (let k = i - 1; k >= 0; k--) if (pages[k].series && pages[k].sheet !== null) { prev = pages[k]; break; }
      for (let k = i + 1; k < pages.length; k++) if (pages[k].series && pages[k].sheet !== null) { nxt = pages[k]; break; }
      if (prev && prev.sheet < p.sheet && (!nxt || nxt.series !== prev.series || nxt.sheet > p.sheet)) p.series = prev.series;
      else if (nxt && nxt.sheet > p.sheet) p.series = nxt.series;
    });
  }

  /**
   * The name as drawn on the schematics: OCR confuses 1/I and 0/O, so when the BOM text
   * is not found but a look-alike spelling is, the look-alike is meant.
   */
  function resolveName(d, pages) {
    if (pages.some((q) => q.tokens.has(d))) return d;
    const swap = { 1: "I", I: "1", 0: "O", O: "0" };
    const pos = [...d].map((c, i) => (swap[c] ? i : -1)).filter((i) => i >= 0).slice(0, 4);
    for (let mask = 1; mask < 1 << pos.length; mask++) {
      const c = [...d];
      pos.forEach((i, k) => { if (mask & (1 << k)) c[i] = swap[c[i]]; });
      const v = c.join("");
      if (pages.some((q) => q.tokens.has(v))) return v;
    }
    return d;
  }

  const SYMBOL_OK = 0.9; // share of the BOM symbol's outline found next to the device
  const SYMBOL_FLOOR = 0.35; // below this the drawing is not comparable at all (e.g. a picture)
  // terminal blocks are pictured in the BOM but drawn as terminal strips on the sheets
  const TERMINAL_BLOCK = /^(?:X|TB|XT)\d+$/;

  /** The tag stands on its own in the line (not a terminal such as -TB01.W1 or X1:5). */
  function standalone(ln, d) {
    const t = compact(ln.text).toUpperCase();
    for (let k = t.indexOf(d); k >= 0; k = t.indexOf(d, k + 1)) {
      const before = k ? t[k - 1] : "", after = t[k + d.length] || "";
      if (/[A-Z0-9]/.test(before) || /[A-Z0-9.:]/.test(after)) continue;
      return true;
    }
    return false;
  }

  /**
   * For every BOM row and every listed sheet that shows one of its devices: is one of
   * the parts of the BOM symbol drawn next to the device tag?  Work is grouped by sheet
   * so that only one page raster is held at a time.
   */
  function symbolFindings(pages) {
    const tasks = new Map(); // schematic page -> [{row, bomPage, names, lines}]
    for (const p of pages) {
      if (!p.pack) continue;
      const sameSeries = pages.filter((q) => q.kind === "schematic" && q.series === p.series && q.sheet !== null && q.pack);
      for (const row of p.bomRows) {
        row.parts = row.parts || SC.symbolParts(p.pack, row.symbolBox).filter((pt) => Math.max(pt.box[2] - pt.box[0], pt.box[3] - pt.box[1]) >= 6).slice(0, 8);
        if (!row.parts.length) continue;
        for (const q of sameSeries) {
          if (!row.sheets.includes(q.sheet)) continue;
          const names = [];
          for (const d0 of row.designations) {
            const d = resolveName(d0, sameSeries);
            if (TERMINAL_BLOCK.test(d)) continue;
            const lines = (q.tokens.get(d) || []).filter((ln) => standalone(ln, d));
            if (lines.length) names.push({ d, lines });
          }
          if (!names.length) continue;
          if (!tasks.has(q)) tasks.set(q, []);
          tasks.get(q).push({ row, bomPage: p, names });
        }
      }
    }
    const byRow = new Map(); // row -> mismatches on all its sheets
    for (const [q, list] of tasks) {
      for (const { row, bomPage, names } of list) {
        for (const { d, lines } of names) {
          let best = { score: 0, box: null, line: lines[0] };
          for (const ln of lines.slice(0, 4)) {
            for (const part of row.parts) {
              const S = 2.2 * Math.max(part.box[2] - part.box[0], part.box[3] - part.box[1]) + 10;
              const r = SC.matchPart(part, bomPage.pack, q.pack, [ln.x0 - S, ln.y0 - S, ln.x1 + S, ln.y1 + S]);
              if (r.score > best.score) best = { score: r.score, box: r.box, line: ln };
              if (best.score >= SYMBOL_OK) break;
            }
            if (best.score >= SYMBOL_OK) break;
          }
          if (best.score >= SYMBOL_OK || best.score < SYMBOL_FLOOR) continue;
          if (!byRow.has(row)) byRow.set(row, { bomPage, bad: [] });
          byRow.get(row).bad.push({ d, q, ...best });
        }
      }
      SC.releaseRaster(q.pack);
    }
    const out = [];
    for (const [row, { bomPage, bad }] of byRow) {
      const names = [...new Set(bad.map((b) => b.d))];
      const list = names.slice(0, 4).map((d) => `-${d}`).join(", ") + (names.length > 4 ? ` และอีก ${names.length - 4} ตัว` : "");
      const sheets = [...new Set(bad.map((b) => b.q.sheet))].sort((a, b) => a - b).map(pad2).join(", ");
      const pct = Math.round(100 * Math.max(...bad.map((b) => b.score)));
      // the BOM symbol first, then the device tag it was compared with (one per sheet)
      const marks = [mark(bomPage.index, row.symbolBox)];
      const shown = new Set();
      for (const b of bad) {
        if (shown.has(b.q) || shown.size >= 6) continue;
        shown.add(b.q);
        marks.push(mark(b.q.index, bb(b.line, 2)));
      }
      out.push(finding("warning", "BOM_SYMBOL_MISMATCH",
        `BOM: สัญลักษณ์ของ ${list} ใน SHEET ${sheets} ไม่ตรงกับช่อง SCHEMATIC DIAGRAM ของ BOM (เหมือนกันมากสุดประมาณ ${pct}%)`,
        `เทียบสัญลักษณ์ในแบบกับใน BOM (ขั้ว จำนวนหน้าสัมผัส รูปแบบ) แล้วแก้ให้ตรงกัน`,
        bomPage.index, bomPage.sheet, marks));
    }
    return out;
  }

  function check(pages) {
    let findings = [];
    // sheet numbers restart in every drawing series, so a cross-reference is resolved
    // inside the series of the page it is written on
    inferSeries(pages);
    const sheets = new Map();
    for (const p of pages) {
      if (p.sheet !== null && (p.kind === "schematic" || p.kind === "bom")) {
        const key = `${p.series}|${p.sheet}`;
        if (!sheets.has(key)) sheets.set(key, p);
      }
    }
    const bySeries = (pi) => ({ get: (s) => sheets.get(`${pages[pi].series}|${s}`) || null });

    const coils = new Map(), contacts = new Map();
    for (const p of pages) {
      for (const c of p.coils) { if (!coils.has(c.tag)) coils.set(c.tag, []); coils.get(c.tag).push(c); }
      for (const c of p.contacts) { if (!contacts.has(c.tag)) contacts.set(c.tag, []); contacts.get(c.tag).push(c); }
    }

    function occurrences(page, tag) {
      const out = [];
      for (const ln of page.tags.get(tag) || []) {
        const H = ln.height;
        // tags sit left of their symbol: look a little further to the right
        const zones = page.grid.zones([ln.x0 - 1.5 * H, ln.y0 - 1.5 * H, ln.x1 + 4 * H, ln.y1 + 1.5 * H]);
        for (const b of ln.boxes) for (const z of page.grid.zones(b)) zones.add(z);
        out.push([ln, zones]);
      }
      return out;
    }

    // 1) coil contact tables -> contact really drawn at that sheet/zone?
    for (const [tag, cl] of coils) {
      for (const coil of cl) {
        const sheetHere = pages[coil.page].sheet;
        const bySheet = bySeries(coil.page);
        for (const row of coil.rows) {
          const x = row.xref;
          const target = bySheet.get(x.sheet);
          const term = row.terminals.join("-");
          if (!target) {
            findings.push(finding("error", "XREF_SHEET_MISSING", `-${tag} contact ${term} อ้างถึง SHEET ${pad2(x.sheet)} ซึ่งไม่มีในชุดแบบ`,
              `ตรวจสอบเลข SHEET ของ ${x}`, coil.page, sheetHere, [mark(coil.page, xb(x))]));
            continue;
          }
          const here = (contacts.get(tag) || []).filter((c) => c.page === target.index);
          if (here.some((c) => x.inZones(c.zone.sheet, c.zones))) continue;
          const occ = occurrences(target, tag);
          if (occ.some(([, z]) => x.inZones(target.sheet, z))) continue;
          const byTerm = here.filter((c) => row.terminals.some((t) => c.terminals.includes(t)));
          const match = byTerm.length ? byTerm : here;
          if (match.length) {
            const best = match[0];
            findings.push(finding("error", "COIL_TABLE_ZONE",
              `-${tag} contact ${term}: ตารางใต้ coil ระบุ ${x} แต่ contact อยู่ที่ ${zs(best.zone)}`,
              `แก้ ${x} เป็น ${zs(best.zone)}`, coil.page, sheetHere, [mark(coil.page, xb(x)), mark(best.page, bb(best.line))]));
          } else if (occ.length) {
            const ln = occ[0][0];
            const z = target.zoneOf(ln.cx, ln.cy);
            findings.push(finding("error", "COIL_TABLE_ZONE",
              `-${tag} contact ${term}: ตารางใต้ coil ระบุ ${x} แต่พบ -${tag} ที่ ${zs(z)}`,
              `แก้ ${x} เป็น ${zs(z)}`, coil.page, sheetHere, [mark(coil.page, xb(x))].concat(occ.map(([o]) => mark(target.index, bb(o))))));
          } else {
            findings.push(finding("error", "COIL_TABLE_MISSING",
              `-${tag} contact ${term}: ตารางใต้ coil ระบุ ${x} แต่ไม่พบ -${tag} ใน SHEET ${pad2(x.sheet)}`,
              `ตรวจสอบ contact ของ -${tag} หรือแก้ ${x}`, coil.page, sheetHere, [mark(coil.page, xb(x))]));
          }
        }
      }
    }

    // 2) contacts -> back-reference points at the coil/device, and the coil table lists the contact
    for (const [tag, cl] of contacts) {
      const coilList = coils.get(tag) || [];
      for (const c of cl) {
        const ref = c.backref;
        const here = zs(c.zone);
        const bySheet = bySeries(c.page);
        if (ref) {
          const target = bySheet.get(ref.sheet);
          let ok = coilList.some((k) => ref.inZones(k.zone.sheet, k.zones));
          const occ = target ? occurrences(target, tag) : [];
          if (!ok && target) {
            const contactLines = new Set((contacts.get(tag) || []).map((k) => k.line));
            ok = occ.some(([ln, z]) => !contactLines.has(ln) && ref.inZones(target.sheet, z));
          }
          if (!ok) {
            if (!target) {
              findings.push(finding("error", "BACKREF_SHEET_MISSING", `contact -${tag} ที่ ${here} อ้างถึง ${ref} แต่ไม่มี SHEET ${pad2(ref.sheet)} ในชุดแบบ`,
                `ตรวจสอบเลข SHEET ใน ${ref}`, c.page, c.zone.sheet, [mark(c.page, xb(ref))]));
            } else if (coilList.length) {
              const k = coilList[0];
              findings.push(finding("error", "BACKREF_ZONE", `contact -${tag} ที่ ${here} ระบุตำแหน่ง coil เป็น ${ref} แต่ coil -${tag} อยู่ที่ ${zs(k.zone)}`,
                `แก้ ${ref} เป็น ${zs(k.zone)}`, c.page, c.zone.sheet, [mark(c.page, xb(ref)), mark(k.page, bb(k.line))]));
            } else if (occ.length) {
              const ln = occ[0][0];
              const z = target.zoneOf(ln.cx, ln.cy);
              findings.push(finding("error", "BACKREF_ZONE", `contact -${tag} ที่ ${here} ระบุตำแหน่งอุปกรณ์เป็น ${ref} แต่พบ -${tag} ที่ ${zs(z)}`,
                `แก้ ${ref} เป็น ${zs(z)}`, c.page, c.zone.sheet, [mark(c.page, xb(ref))].concat(occ.map(([o]) => mark(target.index, bb(o))))));
            } else {
              findings.push(finding("error", "BACKREF_NOT_FOUND", `contact -${tag} ที่ ${here} อ้างถึง ${ref} แต่ไม่พบ -${tag} ใน SHEET ${pad2(ref.sheet)}`,
                `ตรวจสอบตำแหน่งอุปกรณ์ -${tag} หรือแก้ ${ref}`, c.page, c.zone.sheet, [mark(c.page, xb(ref))]));
            }
          }
        }
        if (coilList.length && coilList[0].rows.length) {
          const listed = coilList.some((k) => k.rows.some((r) => r.xref.inZones(c.zone.sheet, c.zones)));
          if (!listed) {
            const k = coilList[0];
            findings.push(finding("error", "CONTACT_NOT_LISTED", `contact -${tag} ที่ ${here} ไม่มีอยู่ในตารางใต้ coil -${tag}`,
              `เพิ่ม/แก้ตาราง contact ใต้ coil -${tag} ให้มี ${here}`, c.page, c.zone.sheet,
              [mark(c.page, bb(c.line))].concat(k.rows.map((r) => mark(k.page, xb(r.xref))))));
          }
        }
      }
    }

    // 3) BOM: every designation must appear on (at least one of) the sheets of each SHEET
    //    cell of its row, and every listed sheet must show at least one of the row's devices
    const bomTags = new Set();
    for (const p of pages) {
      const bySheet = bySeries(p.index);
      const sameSeries = pages.filter((q) => q.kind === "schematic" && q.series === p.series && q.sheet !== null);
      for (const row of p.bomRows) {
        const names = row.designations.slice(0, 4).join(", ") + (row.designations.length > 4 ? "..." : "");
        const sheetMarks = (cell) => (cell ? cell.lines : row.sheetLines).map((ln) => mark(p.index, bb(ln)));
        for (const s of row.sheets.filter((s) => !bySheet.get(s))) {
          findings.push(finding("error", "BOM_SHEET_MISSING", `BOM: ${names} ระบุ SHEET ${pad2(s)} ซึ่งไม่มีในชุดแบบ`,
            `แก้เลข SHEET ${pad2(s)}`, p.index, p.sheet, sheetMarks(row.cells.find((c) => c.sheets.includes(s)))));
        }
        const split = row.cells.length > 1;
        for (const d0 of row.designations) {
          const d = resolveName(d0, sameSeries);
          bomTags.add(d);
          const foundOn = [...new Set(sameSeries.filter((q) => q.tokens.has(d)).map((q) => q.sheet))].sort((a, b) => a - b);
          const desigMarks = row.desigLines.filter((ln) => compact(ln.text).includes(d0) || compact(ln.text).includes(d)).map((ln) => mark(p.index, bb(ln)));
          if (!foundOn.length) {
            if (row.sheets.length) {
              findings.push(finding("warning", "BOM_NOT_FOUND", `BOM: ไม่พบ -${d} ใน SHEET ${row.sheets.map(pad2).join(", ")} (และไม่พบในหน้าอื่น)`,
                `ตรวจสอบชื่ออุปกรณ์ ${d} ในแบบ`, p.index, p.sheet, desigMarks.length ? desigMarks : row.desigLines.map((ln) => mark(p.index, bb(ln)))));
            }
            continue;
          }
          for (const cell of row.cells) {
            if (cell.sheets.some((s) => foundOn.includes(s))) continue;
            const where = foundOn.map(pad2).join(", ");
            const part = split ? ` (ช่อง SHEET ${cell.sheets.map(pad2).join(", ")})` : "";
            findings.push(finding("error", "BOM_NOT_ON_SHEET", `BOM: ${d} ระบุ SHEET ${cell.sheets.map(pad2).join(", ")}${part ? " สำหรับสัญลักษณ์ส่วนนั้น" : ""} แต่พบ -${d} ที่ SHEET ${where}`,
              `แก้ช่อง SHEET ของ ${d}${part} หรือตรวจชื่อ -${d} ในแบบ SHEET ${cell.sheets.map(pad2).join(", ")}`,
              p.index, p.sheet, desigMarks.concat(sheetMarks(cell))));
          }
        }
        for (const cell of row.cells) {
          for (const s of cell.sheets) {
            const q = bySheet.get(s);
            if (q && !row.designations.some((d) => q.tokens.has(resolveName(d, sameSeries)))) {
              findings.push(finding("warning", "BOM_SHEET_UNUSED", `BOM: SHEET ${pad2(s)} ไม่มีอุปกรณ์ในแถวนี้ (${names})`,
                `ตรวจสอบเลข SHEET ${pad2(s)} หรือชื่ออุปกรณ์ในแบบ SHEET ${pad2(s)}`, p.index, p.sheet, sheetMarks(cell)));
            }
          }
        }
      }
    }

    // 3b) BOM symbols: the symbol of the row must be the one drawn next to the device
    findings.push(...symbolFindings(pages));

    // 4) coils on schematics that the BOM does not list (only when a BOM exists)
    if (bomTags.size) {
      for (const [tag, cl] of coils) {
        if (!bomTags.has(tag)) {
          const c = cl[0];
          findings.push(finding("warning", "NOT_IN_BOM", `coil -${tag} ไม่มีใน BOM`, `เพิ่ม ${tag} ใน BOM`, c.page, c.zone.sheet, [mark(c.page, bb(c.line))]));
        }
      }
    }

    const seen = new Set();
    findings = findings.filter((f) => {
      const key = f.code + "\u0000" + f.message;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let coilCount = 0, rowCount = 0, contactCount = 0;
    for (const cl of coils.values()) { coilCount += cl.length; for (const c of cl) rowCount += c.rows.length; }
    for (const cl of contacts.values()) contactCount += cl.length;
    const stats = {
      pages: pages.length,
      schematic_pages: pages.filter((p) => p.kind === "schematic").length,
      bom_pages: pages.filter((p) => p.kind === "bom").length,
      coils: coilCount,
      contact_rows: rowCount,
      contacts: contactCount,
      bom_designations: bomTags.size,
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
    };
    const pageMeta = pages.map((p) => ({ index: p.index, sheet: p.sheet, series: p.series, kind: p.kind, width: p.width, height: p.height }));
    return { pages: pageMeta, findings, stats };
  }

  SC.check = check;
})(typeof globalThis !== "undefined" ? (globalThis.SC = globalThis.SC || {}) : (self.SC = self.SC || {}));
