// End-to-end test of dist/standalone.html in Chromium (debug aid).
// node test/browser.cjs FILE.pdf OUT_DIR
const path = require("path");
const fs = require("fs");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");
const nm = path.join(__dirname, "..", "node_modules");
const LIBS = {
  "pdf.min.js": path.join(nm, "pdfjs-dist/build/pdf.min.js"),
  "pdf.worker.min.js": path.join(nm, "pdfjs-dist/build/pdf.worker.min.js"),
  "pdf-lib.min.js": path.join(nm, "pdf-lib/dist/pdf-lib.min.js"),
};

(async () => {
  const [pdfFile, out] = process.argv.slice(2);
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.route("**/*", (route) => {
    const u = route.request().url();
    const lib = Object.keys(LIBS).find((k) => u.endsWith("/" + k));
    if (lib) return route.fulfill({ path: LIBS[lib], contentType: "text/javascript", headers: { "Access-Control-Allow-Origin": "*" } });
    if (u.includes("fonts.g")) return route.fulfill({ body: "", contentType: "text/css" });
    return route.continue();
  });
  // pretend to be inside Apps Script so the Drive/Sheets buttons appear
  await p.addInitScript(() => {
    window.__gsCalls = [];
    const run = {};
    let ok = null, fail = null;
    const handler = { get(_, k) {
      if (k === "withSuccessHandler") return (f) => { ok = f; return proxy; };
      if (k === "withFailureHandler") return (f) => { fail = f; return proxy; };
      return (...args) => { window.__gsCalls.push([k, args[0], typeof args[1] === "string" ? args[1].length : JSON.stringify(args[1]).length]); setTimeout(() => ok && ok("https://example.com/" + k), 10); };
    } };
    const proxy = new Proxy(run, handler);
    window.google = { script: { run: proxy } };
  });
  await p.goto("file://" + path.join(__dirname, "..", "dist", "standalone.html"));
  await p.screenshot({ path: path.join(out, "gas_upload.png") });
  const t = Date.now();
  await p.setInputFiles("#fileInput", pdfFile);
  await p.waitForSelector(".finding, .empty", { timeout: 600000 });
  console.log("check took", (Date.now() - t) / 1000, "s");
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(out, "gas_result.png") });
  const items = await p.$$(".finding");
  console.log("findings shown:", items.length, "summary:", (await p.textContent("#summary")).replace(/\s+/g, " ").trim());
  if (items.length > 5) { await items[5].click(); await p.waitForTimeout(1500); await p.screenshot({ path: path.join(out, "gas_result2.png") }); }
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#dlPdf")]);
  await dl.saveAs(path.join(out, "gas_checked.pdf"));
  const [dl2] = await Promise.all([p.waitForEvent("download"), p.click("#dlCsv")]);
  await dl2.saveAs(path.join(out, "gas_report.csv"));
  await p.click("#toSheet"); await p.waitForTimeout(500);
  await p.click("#toDrive"); await p.waitForTimeout(3000);
  console.log("apps script calls:", JSON.stringify(await p.evaluate(() => window.__gsCalls)));
  await p.screenshot({ path: path.join(out, "gas_toast.png") });
  console.log("errors:", errs);
  await b.close();
})();
