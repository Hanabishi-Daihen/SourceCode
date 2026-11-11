// Speed benchmark on dense synthetic sheets:  node test/bench.mjs [sheets] [--profile]
import fs from "node:fs";
import vm from "node:vm";
import { loadCore } from "./load-core.mjs";
import { Sheet, sources } from "./synth.mjs";

/** `n` sheets about as busy as a real control schematic (coils, tables, contacts, terminals, notes). */
export function denseSheets(n) {
  const sheets = [];
  const L = "ABCDEFGHJK";
  const ref = (sheet, zone) => `/${String(sheet).padStart(2, "0")}.${zone}`;
  for (let k = 0; k < n; k++) {
    const no = k + 1, next = ((k + 1) % n) + 1, prev = ((k - 1 + n) % n) + 1;
    const s = new Sheet(no);
    // ten relays in row F, their four contacts each on the next sheet in rows B..E
    for (let c = 1; c <= 10; c++) {
      const rows = [];
      for (let r = 0; r < 8; r++) rows.push([String(1 + r), String(9 + r), r < 4 ? ref(next, `${"BCDE"[r]}${c}`) : ""]);
      s.coil(`K${no}${L[c - 1]}`, `F${c}`, rows, { label: "FAN START", fx: 0.55 });
      [..."BCDE"].forEach((row, r) => s.contact(`K${prev}${L[c - 1]}`, `${row}${c}`, ref(prev, `F${c}`), [String(1 + r), String(9 + r)], { fx: 0.6 }));
    }
    // terminal strip along the top, notes along the bottom, dashed panel frame
    for (let t = 0; t < 40; t++) {
      const x = 80 + t * 26;
      s.line([x, 62], [x, 84]).rect(x - 2, 84, x + 2, 88);
      s.text(x - 3, 138, `-TB0${1 + (t % 3)}.${100 + t}`, 6, { rot: 1 });
    }
    for (let t = 0; t < 12; t++) s.text(80 + (t % 3) * 330, 668 + Math.floor(t / 3) * 11, "SETTING VALUE HYSTERESIS 10 PERCENT TIME DELAY 5 SEC", 5.5);
    s.dashed(58, 60, 1126, 60).dashed(58, 60, 58, 722).dashed(1126, 60, 1126, 722).dashed(58, 722, 1126, 722);
    sheets.push(s);
  }
  return sheets;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const SC = loadCore();
  vm.runInThisContext(fs.readFileSync(new URL("../build/glyphs.js", import.meta.url), "utf8"));
  let t = performance.now();
  const lib = new SC.TemplateLibrary(globalThis.SC_GLYPHS);
  const tLib = performance.now() - t;
  const n = parseInt(process.argv[2], 10) || 20;
  const srcs = sources(SC, denseSheets(n));
  const strokes = srcs.reduce((a, s) => a + s.strokes.length, 0);
  t = performance.now();
  const pages = srcs.map((s) => SC.analysePage(s, lib, {}));
  const tPages = performance.now() - t;
  t = performance.now();
  const rep = SC.check(pages, {});
  const tCheck = performance.now() - t;
  const st = rep.stats;
  console.log(`library ${tLib.toFixed(0)} ms; ${n} sheets, ${Math.round(strokes / n)} strokes/sheet: analyse ${(tPages / n).toFixed(1)} ms/sheet, check ${tCheck.toFixed(0)} ms`);
  console.log(`coils ${st.coils}, table rows ${st.table_rows_ok}/${st.table_rows_checked} ok, contacts ${st.contacts_ok}/${st.contacts_checked} ok, findings ${rep.findings.length}`);
}
