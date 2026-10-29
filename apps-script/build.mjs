// Build the Apps Script project (dist/apps-script) and a single-file page (dist/standalone.html).
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { CORE } from "./test/load-core.mjs";

const r = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
execFileSync(process.execPath, [new URL("./build-glyphs.mjs", import.meta.url).pathname], { stdio: "inherit" });

const nm = (p) => r(`./node_modules/${p}`);

// Libraries are stored as base64 in short lines inside inert <script type="text/plain">
// blocks: the Apps Script editor cannot take the 300-500k character lines of minified
// code, and base64 cannot be misread by any HTML parser.  ui.js decodes and runs them.
const LINE = 100;
const MAX_FILE = 400 * 1024;
const libs = [];
function addLib(key, fileBase, code) {
  const b64 = Buffer.from(code, "utf8").toString("base64");
  const lines = b64.match(new RegExp(`.{1,${LINE}}`, "g"));
  const perFile = Math.floor(MAX_FILE / (LINE + 1));
  const n = Math.ceil(lines.length / perFile);
  for (let i = 0; i < n; i++) {
    const chunk = lines.slice(i * perFile, (i + 1) * perFile);
    const name = n > 1 ? `${fileBase}${i + 1}` : fileBase;
    const len = chunk.reduce((a, l) => a + l.length, 0);
    libs.push({
      key: `lib:${name}`, name,
      body: `<script type="text/plain" class="sc-lib" data-lib="${key}" data-file="${name}" data-part="${i + 1}" ` +
        `data-parts="${n}" data-len="${len}">\n${chunk.join("\n")}\n</script>\n`,
    });
  }
}
addLib("pdfjs", "PdfJs", nm("pdfjs-dist/build/pdf.min.js"));
addLib("pdfjs-worker", "PdfWorker", nm("pdfjs-dist/build/pdf.worker.min.js"));
addLib("pdflib", "PdfLib", nm("pdf-lib/dist/pdf-lib.min.js"));

const parts = {
  "style.css": { name: "Styles", body: `<style>\n${r("./src/ui/style.css")}</style>\n` },
  "core.js": { name: "Core", body: `<script>\n${CORE.map((f) => r(`./src/core/${f}`)).join("\n")}</script>\n` },
  // one template per line keeps the Apps Script editor responsive
  "glyphs.js": { name: "Glyphs", body: `<script>\n${r("./build/glyphs.js").replace(/\],\[/g, "],\n[")}</script>\n` },
  "ui.js": { name: "Ui", body: `<script>\n${r("./src/ui/ui.js")}</script>\n` },
};
for (const l of libs) parts[l.key] = l;
for (const { name, body } of Object.values(parts)) {
  const longest = Math.max(...body.split("\n").map((l) => l.length));
  if (longest > 1000) throw new Error(`${name}: line of ${longest} characters is too long for the Apps Script editor`);
  const inner = body.replace(/<\/script>\n$/, "");
  if (/<\/script/i.test(inner) || inner.includes("<?")) throw new Error(`${name}: content would break the page (</script or <?)`);
}

const index = r("./src/ui/index.html");
const out = new URL("./dist/apps-script/", import.meta.url);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const expand = (html, one) => html.replace(/<!-- @include (\S+) -->/g, (_, f) =>
  f === "libs" ? libs.map((l) => one(l)).join("\n  ") : one(parts[f]));
fs.writeFileSync(new URL("Index.html", out), expand(index, (p) => `<?!= include('${p.name}'); ?>`));
for (const { name, body } of Object.values(parts)) fs.writeFileSync(new URL(`${name}.html`, out), body);
fs.copyFileSync(new URL("./src/gas/Code.gs", import.meta.url), new URL("Code.gs", out));
fs.copyFileSync(new URL("./src/gas/appsscript.json", import.meta.url), new URL("appsscript.json", out));

if (/https?:\/\/(?!www\.w3\.org)/.test(index + parts["ui.js"].body + parts["style.css"].body)) throw new Error("page refers to an external site");
const standalone = expand(index, (p) => p.body);
fs.writeFileSync(new URL("./dist/standalone.html", import.meta.url), standalone);
for (const f of fs.readdirSync(out)) console.error(`dist/apps-script/${f}  ${(fs.statSync(new URL(f, out)).size / 1024).toFixed(0)} KB`);
console.error(`dist/standalone.html  ${(fs.statSync(new URL("./dist/standalone.html", import.meta.url)).size / 1024).toFixed(0)} KB`);
