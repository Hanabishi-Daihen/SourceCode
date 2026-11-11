/* Run the whole check on a pdf.js document. */
(function (SC) {
  "use strict";

  /** Everything the analysis needs from one pdf.js page. */
  async function pageSource(page, index, OPS) {
    const vp = page.getViewport({ scale: 1 });
    const [ops, text] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
    return {
      index,
      width: vp.width,
      height: vp.height,
      viewportTransform: vp.transform,
      strokes: SC.extractStrokes(ops, vp.transform, OPS),
      textItems: text.items.filter((it) => typeof it.str === "string"),
    };
  }

  /**
   * Analyse every page of `pdf` (a pdf.js PDFDocumentProxy) and cross-check them.
   * onProgress(done, total) is called after each page; the event loop is yielded to
   * between pages so the page stays responsive.
   */
  async function runCheck(pdf, lib, OPS, onProgress, opts = {}) {
    const n = pdf.numPages;
    const pages = [];
    const viewports = [];
    // pdf.js parses pages in its worker: ask for the next ones while this one is analysed
    const AHEAD = 2;
    const pending = new Map();
    const fetch = (i) => {
      if (i < n && !pending.has(i)) pending.set(i, pdf.getPage(i + 1).then((page) => pageSource(page, i, OPS).then((src) => ({ page, src }))));
    };
    let lastYield = Date.now();
    for (let i = 0; i < n; i++) {
      for (let k = i; k <= i + AHEAD; k++) fetch(k);
      const { page, src } = await pending.get(i);
      pending.delete(i);
      viewports.push(src.viewportTransform);
      pages.push(SC.analysePage(src, lib, { bom: !!opts.bom }));
      page.cleanup();
      if (onProgress) onProgress(i + 1, n);
      // let the page repaint now and then (a timer per sheet would cost more than it gives)
      if (Date.now() - lastYield > 60 || i === n - 1) {
        await new Promise((r) => setTimeout(r, 0));
        lastYield = Date.now();
      }
    }
    const report = SC.check(pages, opts);
    report.viewports = viewports;
    return report;
  }

  SC.pageSource = pageSource;
  SC.runCheck = runCheck;
})(typeof globalThis !== "undefined" ? (globalThis.SC = globalThis.SC || {}) : (self.SC = self.SC || {}));
