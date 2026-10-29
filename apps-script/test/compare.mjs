// Compare the JS reader with a Python reference dump (debug aid).
// node test/compare.mjs ref.json DIR_WITH_PDFS
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { loadCore } from "./load-core.mjs";

const require = createRequire(import.meta.url);
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const SC = loadCore();
vm.runInThisContext(fs.readFileSync(new URL("../build/glyphs.js", import.meta.url), "utf8"));
const lib = new SC.TemplateLibrary(globalThis.SC_GLYPHS);
const ref = JSON.parse(fs.readFileSync(process.argv[2]));
const docs = {};
let tot = 0, hit = 0, ctot = 0, chit = 0;
const interesting = (t) => /^-[0-9]*[A-Z]|\/\d+\.[A-L]\d/.test(t.replace(/ /g, ""));
for (const [key, r] of Object.entries(ref)) {
  const [file, p] = key.split(":");
  docs[file] ??= await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(`${process.argv[3]}/${file}`)), isEvalSupported: false }).promise;
  const page = await docs[file].getPage(+p);
  const info = SC.analysePage(await SC.pageSource(page, +p - 1, pdfjs.OPS), lib);
  const mine = new Map();
  for (const l of info.lines) if (l.glyphs.length) mine.set(l.text, (mine.get(l.text) || 0) + 1);
  const want = r.lines.filter(interesting);
  let h = 0;
  const miss = [];
  for (const t of want) { if (mine.get(t) > 0) { mine.set(t, mine.get(t) - 1); h++; } else miss.push(t); }
  const coils = info.coils.map((c) => `${c.tag} ${c.zone.sheet}.${c.zone.row}${c.zone.col} ` + c.rows.map((x) => String(x.xref)).join(",")).sort();
  const cts = info.contacts.map((c) => `${c.tag} ${c.zone.sheet}.${c.zone.row}${c.zone.col} ${c.backref}`).sort();
  const same = (a, b) => a.filter((x) => b.includes(x)).length;
  const c1 = same(r.coils, coils) + same(r.contacts, cts), c2 = r.coils.length + r.contacts.length;
  tot += want.length; hit += h; ctot += c2; chit += c1;
  console.log(`${key}: tags/xrefs ${h}/${want.length}  coils+contacts ${c1}/${c2}  missing: ${miss.slice(0, 12).join(" | ")}`);
}
console.log(`TOTAL tags/xrefs ${hit}/${tot} (${((100 * hit) / tot).toFixed(1)}%)  coils+contacts ${chit}/${ctot} (${((100 * chit) / ctot).toFixed(1)}%)`);
