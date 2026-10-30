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
    for (let i = 0; i < n; i++) {
      const page = await pdf.getPage(i + 1);
      const src = await pageSource(page, i, OPS);
      viewports.push(src.viewportTransform);
      pages.push(SC.analysePage(src, lib, { bom: !!opts.bom }));
      page.cleanup();
      if (onProgress) onProgress(i + 1, n);
      await new Promise((r) => setTimeout(r, 0));
    }
    const report = SC.check(pages, opts);
    report.viewports = viewports;
    return report;
  }

  SC.pageSource = pageSource;
  SC.runCheck = runCheck;
})(typeof globalThis !== "undefined" ? (globalThis.SC = globalThis.SC || {}) : (self.SC = self.SC || {}));
