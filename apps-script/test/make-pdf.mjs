// Write the synthetic drawing sets as PDFs (for the browser test and for trying the app by hand):
//   node test/make-pdf.mjs [OUT_DIR] [dense sheets]
import fs from "node:fs";
import path from "node:path";
import { toPdf } from "./synth.mjs";
import { build } from "./scenarios.mjs";
import { denseSheets } from "./bench.mjs";

const out = process.argv[2] || new URL("../build/", import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "scenarios.pdf"), await toPdf(build().sheets));
fs.writeFileSync(path.join(out, "dense.pdf"), await toPdf(denseSheets(parseInt(process.argv[3], 10) || 40)));
console.log(`wrote ${path.join(out, "scenarios.pdf")} and ${path.join(out, "dense.pdf")}`);
