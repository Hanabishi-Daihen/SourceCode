// End-to-end test of dist/standalone.html in Chromium (debug aid).
// node test/browser.cjs FILE.pdf OUT_DIR
const path = require("path");
const fs = require("fs");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");

(async () => {
  const [pdfFile, out] = process.argv.slice(2);
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript((noWorker) => {
    // record whether pdf.js got a real Web Worker (NO_WORKER=1 simulates a browser without them)
    const W = window.Worker;
    window.__workers = 0;
    window.Worker = function (...a) { if (noWorker) throw new Error("workers disabled"); window.__workers++; return new W(...a); };
  }, !!process.env.NO_WORKER);
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  // the page must be self-contained: refuse and record every request to another site
  const external = [];
  await p.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith("file:") || u.startsWith("blob:") || u.startsWith("data:")) return route.continue();
    external.push(u);
    return route.abort();
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
  // the other exports sit in the "ส่งออกแบบอื่น" menu
  const menu = async (id) => { await p.click("#moreBtn"); await p.click(id); };
  const [dl2] = await Promise.all([p.waitForEvent("download"), menu("#dlCsv")]);
  await dl2.saveAs(path.join(out, "gas_report.csv"));
  await menu("#toSheet"); await p.waitForTimeout(500);
  await menu("#toDrive"); await p.waitForTimeout(3000);
  console.log("web workers started:", await p.evaluate(() => window.__workers));
  console.log("apps script calls:", JSON.stringify(await p.evaluate(() => window.__gsCalls)));
  await p.screenshot({ path: path.join(out, "gas_toast.png") });
  console.log("external requests:", external);
  console.log("errors:", errs);
  await b.close();
})();
