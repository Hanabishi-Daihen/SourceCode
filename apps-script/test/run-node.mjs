// Run the browser pipeline in Node on a PDF:  node test/run-node.mjs FILE.pdf [out.json] [--lines PAGE]
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { loadCore } from "./load-core.mjs";

const require = createRequire(import.meta.url);
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const SC = loadCore();
vm.runInThisContext(fs.readFileSync(new URL("../build/glyphs.js", import.meta.url), "utf8"));
const lib = new SC.TemplateLibrary(globalThis.SC_GLYPHS);

const file = process.argv[2];
const linesPage = process.argv.indexOf("--lines") > 0 ? +process.argv[process.argv.indexOf("--lines") + 1] : null;
const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, disableFontFace: true }).promise;

if (linesPage) {
  const page = await pdf.getPage(linesPage);
  const t = Date.now();
  const src = await SC.pageSource(page, linesPage - 1, pdfjs.OPS);
  const info = SC.analysePage(src, lib);
  console.error(`page ${linesPage}: ${src.strokes.length} strokes, ${info.lines.length} lines, ${Date.now() - t} ms; sheet ${info.sheet} ${info.series} ${info.kind}`);
  const sorted = info.lines.slice().sort((a, b) => Math.round(a.y0 / 8) - Math.round(b.y0 / 8) || a.x0 - b.x0);
  console.log(sorted.filter((l) => l.text.length > 3).map((l) => l.text).join(" ; "));
  for (const c of info.coils) console.log("COIL", c.tag, `${c.zone.sheet}.${c.zone.row}${c.zone.col}`, [...c.zones].join("/"), c.rows.map((r) => `${r.terminals.join("-")} ${r.xref}`).join(", "));
  for (const c of info.contacts) console.log("CONTACT", c.tag, `${c.zone.sheet}.${c.zone.row}${c.zone.col}`, [...c.zones].join("/"), "->", String(c.backref), "terms", c.terminals.join("-"));
  for (const r of info.bomRows) console.log("BOM", r.designations.join(","), r.sheets.join(","));
  process.exit(0);
}

const t = Date.now();
const rep = await SC.runCheck(pdf, lib, pdfjs.OPS, (i, n) => process.stderr.write(`\r${i}/${n}`), { bom: process.argv.includes("--bom") });
console.error(`\n${((Date.now() - t) / 1000).toFixed(1)}s`, JSON.stringify(rep.stats));
for (const f of rep.findings) console.log(`[${f.severity}] p${f.page + 1} s${f.sheet} ${f.code}: ${f.message}  => ${f.fix}`);
if (process.argv[3] && !process.argv[3].startsWith("--")) fs.writeFileSync(process.argv[3], JSON.stringify(rep));
