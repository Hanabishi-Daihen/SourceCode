// Run the regression drawing set:  node test/scenarios-test.mjs [-v]
import fs from "node:fs";
import vm from "node:vm";
import { loadCore } from "./load-core.mjs";
import { sources } from "./synth.mjs";
import { build } from "./scenarios.mjs";

const SC = loadCore();
vm.runInThisContext(fs.readFileSync(new URL("../build/glyphs.js", import.meta.url), "utf8"));
const lib = new SC.TemplateLibrary(globalThis.SC_GLYPHS);
const verbose = process.argv.includes("-v");

const { sheets, expected, zones } = build();
const pages = sources(SC, sheets).map((s) => SC.analysePage(s, lib, {}));
if (verbose) {
  for (const p of pages) {
    console.log(`sheet ${p.sheet} ${p.series} ${p.kind}`);
    for (const c of p.coils) console.log("  COIL", c.tag, c.zone.row + c.zone.col, [...c.zones].join("/"), c.rows.map((r) => `${r.terminals.join("-")} ${r.xref}`).join(", "));
    for (const c of p.contacts) console.log("  CONTACT", c.tag, c.zone.row + c.zone.col, [...c.zones].join("/"), "->", String(c.backref), c.terminals.join("-"));
  }
}
const report = SC.check(pages, {});
const left = report.findings.slice();
let bad = 0;
for (const e of expected) {
  const k = left.findIndex((f) => f.code === e.code && e.has.every((h) => (f.message + " " + f.fix).includes(h)));
  if (k < 0) { bad++; console.log(`MISSING  ${e.code}  ${e.has.join(" | ")}`); } else left.splice(k, 1);
}
for (const [tag, sheet, zone] of zones) {
  const c = pages.flatMap((p) => p.contacts).find((k) => k.tag === tag && k.zone.sheet === sheet);
  const got = c ? c.zone.row + c.zone.col : "not found";
  if (got !== zone) { bad++; console.log(`ZONE     contact -${tag} on sheet ${sheet}: ${got}, expected ${zone}`); }
}
for (const f of left) { bad++; console.log(`EXTRA    ${f.code}  ${f.message}  => ${f.fix}`); }
const s = report.stats;
console.log(`${expected.length} expected findings, ${report.findings.length} reported; table rows ${s.table_rows_ok}/${s.table_rows_checked} ok, contacts ${s.contacts_ok}/${s.contacts_checked} ok`);
if (bad) { console.log(`${bad} difference(s)`); process.exit(1); }
console.log("regression drawing set passed");
if (verbose) for (const f of report.findings) console.log(`  ${f.code}: ${f.message}  => ${f.fix}`);
