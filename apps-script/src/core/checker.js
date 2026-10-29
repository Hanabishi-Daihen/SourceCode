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
      if (p.series !== null || p.sheet === null) return;
      let prev = null, nxt = null;
      for (let k = i - 1; k >= 0; k--) if (pages[k].series && pages[k].sheet !== null) { prev = pages[k]; break; }
      for (let k = i + 1; k < pages.length; k++) if (pages[k].series && pages[k].sheet !== null) { nxt = pages[k]; break; }
      if (prev && prev.sheet < p.sheet && (!nxt || nxt.series !== prev.series || nxt.sheet > p.sheet)) p.series = prev.series;
      else if (nxt && nxt.sheet > p.sheet) p.series = nxt.series;
    });
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

    // 3) BOM: every designation must appear on (at least one of) the sheets listed in its row
    const bomTags = new Set();
    for (const p of pages) {
      const bySheet = bySeries(p.index);
      const sameSeries = pages.filter((q) => q.kind === "schematic" && q.series === p.series && q.sheet !== null);
      for (const row of p.bomRows) {
        const listed = row.sheets;
        const names = row.designations.slice(0, 4).join(", ") + (row.designations.length > 4 ? "..." : "");
        for (const s of listed.filter((s) => !bySheet.get(s))) {
          findings.push(finding("error", "BOM_SHEET_MISSING", `BOM: ${row.designations.slice(0, 4).join(", ")} ระบุ SHEET ${pad2(s)} ซึ่งไม่มีในชุดแบบ`,
            `แก้เลข SHEET ${pad2(s)}`, p.index, p.sheet, row.sheetLines.map((ln) => mark(p.index, bb(ln)))));
        }
        for (const d of row.designations) {
          bomTags.add(d);
          const foundOn = [...new Set(sameSeries.filter((q) => q.tokens.has(d)).map((q) => q.sheet))].sort((a, b) => a - b);
          if (!listed.length || listed.some((s) => foundOn.includes(s))) continue;
          const desigMarks = row.desigLines.filter((ln) => compact(ln.text).includes(d)).map((ln) => mark(p.index, bb(ln)));
          if (foundOn.length) {
            const where = foundOn.map(pad2).join(", ");
            findings.push(finding("error", "BOM_NOT_ON_SHEET", `BOM: ${d} ระบุ SHEET ${listed.map(pad2).join(", ")} แต่พบ -${d} ที่ SHEET ${where}`,
              `แก้ช่อง SHEET ของ ${d} เป็น ${where}`, p.index, p.sheet, desigMarks.concat(row.sheetLines.map((ln) => mark(p.index, bb(ln))))));
          } else {
            findings.push(finding("warning", "BOM_NOT_FOUND", `BOM: ไม่พบ -${d} ใน SHEET ${listed.map(pad2).join(", ")} (และไม่พบในหน้าอื่น)`,
              `ตรวจสอบชื่ออุปกรณ์ ${d} ในแบบ`, p.index, p.sheet, desigMarks));
          }
        }
        for (const s of listed) {
          const q = bySheet.get(s);
          if (q && !row.designations.some((d) => q.tokens.has(d))) {
            findings.push(finding("warning", "BOM_SHEET_UNUSED", `BOM: SHEET ${pad2(s)} ไม่มีอุปกรณ์ในแถวนี้ (${names})`,
              `ตรวจสอบเลข SHEET ${pad2(s)}`, p.index, p.sheet, row.sheetLines.map((ln) => mark(p.index, bb(ln)))));
          }
        }
      }
    }

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
