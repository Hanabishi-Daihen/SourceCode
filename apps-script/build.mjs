// Build the Apps Script project (dist/apps-script) and a single-file page (dist/standalone.html).
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { CORE } from "./test/load-core.mjs";

const r = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
execFileSync(process.execPath, [new URL("./build-glyphs.mjs", import.meta.url).pathname], { stdio: "inherit" });

const nm = (p) => r(`./node_modules/${p}`);
const worker = nm("pdfjs-dist/build/pdf.worker.min.js");
const third = Math.ceil(worker.length / 3);
// kept as plain text (not run as a script) and started as a Web Worker by ui.js
const workerPart = (i) => `<script type="text/plain" class="pdfjs-worker">${worker.slice(i * third, (i + 1) * third)}</script>\n`;

const parts = {
  pdfjs: { name: "PdfJs", body: `<script>\n${nm("pdfjs-dist/build/pdf.min.js")}\n</script>\n` },
  pdflib: { name: "PdfLib", body: `<script>\n${nm("pdf-lib/dist/pdf-lib.min.js")}\n</script>\n` },
  worker1: { name: "PdfWorker1", body: workerPart(0) },
  worker2: { name: "PdfWorker2", body: workerPart(1) },
  worker3: { name: "PdfWorker3", body: workerPart(2) },
  "style.css": { name: "Styles", body: `<style>\n${r("./src/ui/style.css")}</style>\n` },
  "core.js": { name: "Core", body: `<script>\n${CORE.map((f) => r(`./src/core/${f}`)).join("\n")}</script>\n` },
  // one template per line keeps the Apps Script editor responsive
  "glyphs.js": { name: "Glyphs", body: `<script>\n${r("./build/glyphs.js").replace(/\],\[/g, "],\n[")}</script>\n` },
  "ui.js": { name: "Ui", body: `<script>\n${r("./src/ui/ui.js")}</script>\n` },
};
for (const { name, body } of Object.values(parts)) {
  const inner = body.replace(/<\/script>\n$/, "");
  if (/<\/script/i.test(inner) || inner.includes("<?")) throw new Error(`${name}: content would break the page (</script or <?)`);
}

const index = r("./src/ui/index.html");
const out = new URL("./dist/apps-script/", import.meta.url);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(new URL("Index.html", out), index.replace(/<!-- @include (\S+) -->/g, (_, f) => `<?!= include('${parts[f].name}'); ?>`));
for (const { name, body } of Object.values(parts)) fs.writeFileSync(new URL(`${name}.html`, out), body);
fs.copyFileSync(new URL("./src/gas/Code.gs", import.meta.url), new URL("Code.gs", out));
fs.copyFileSync(new URL("./src/gas/appsscript.json", import.meta.url), new URL("appsscript.json", out));

if (/https?:\/\/(?!www\.w3\.org)/.test(index + parts["ui.js"].body + parts["style.css"].body)) throw new Error("page refers to an external site");
const standalone = index.replace(/<!-- @include (\S+) -->/g, (_, f) => parts[f].body);
fs.writeFileSync(new URL("./dist/standalone.html", import.meta.url), standalone);
for (const f of fs.readdirSync(out)) console.error(`dist/apps-script/${f}  ${(fs.statSync(new URL(f, out)).size / 1024).toFixed(0)} KB`);
console.error(`dist/standalone.html  ${(fs.statSync(new URL("./dist/standalone.html", import.meta.url)).size / 1024).toFixed(0)} KB`);
