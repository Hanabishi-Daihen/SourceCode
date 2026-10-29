// Load the browser core scripts into Node (they attach to globalThis.SC).
import fs from "node:fs";
import vm from "node:vm";

export const CORE = ["strokes.js", "glyphs.js", "ocr.js", "model.js", "checker.js", "pipeline.js"];

export function loadCore() {
  for (const f of CORE) {
    const code = fs.readFileSync(new URL(`../src/core/${f}`, import.meta.url), "utf8");
    vm.runInThisContext(code, { filename: f });
  }
  return globalThis.SC;
}
