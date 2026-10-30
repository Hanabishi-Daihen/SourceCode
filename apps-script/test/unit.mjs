// Unit tests for the browser core:  node test/unit.mjs
import assert from "node:assert/strict";
import { loadCore } from "./load-core.mjs";

const SC = loadCore();
const { parseDesignations, parseSheetList, designationText, tagsIn, tokens } = SC._test;

assert.deepEqual(parseDesignations("QFM1. QFM2."), ["QFM1", "QFM2"]);
assert.deepEqual(parseDesignations("HR1-HR3"), ["HR1", "HR2", "HR3"]);
assert.deepEqual(parseDesignations("88F1.88F2,88FX1"), ["88F1", "88F2", "88FX1"]);
assert.deepEqual(parseSheetList("04. 09"), [4, 9]);
assert.deepEqual(parseSheetList("20-22"), [20, 21, 22]);
assert.deepEqual(parseSheetList("34 - 35"), [34, 35]);
// BOM designation cells
assert.deepEqual(parseDesignations("TB01-TB03"), ["TB01", "TB02", "TB03"]); // zero padding kept
assert.deepEqual(parseDesignations("KL1-KL10").length, 10);
assert.deepEqual(parseDesignations("PSU8 - PSU9"), ["PSU8", "PSU9"]);
assert.deepEqual(parseDesignations("3CL,3BL,11L, (G,R,BK)"), ["3CL", "3BL", "11L"]); // colour note
assert.deepEqual(parseDesignations("47"), ["47"]);
assert.deepEqual(parseDesignations("51-1, 51-2"), ["51-1", "51-2"]);
assert.deepEqual(parseDesignations("CPU-I"), ["CPU-I"]);
assert.deepEqual(parseDesignations("K7-K34, KS1-KS2").length, 30);
const L = (text, cy, x0 = 0, height = 7) => ({ text, cy, x0, height });
assert.equal(designationText([L("PSU1-", 10), L("PSU7", 20)]), "PSU1-PSU7"); // range over two lines
assert.equal(designationText([L("QL4,QL5,QL6", 10), L("A", 20, 40, 5)]), "QL4,QL5,QL6"); // revision mark
assert.ok(tokens("-47").has("47"));
assert.ok(tokens("-51-1 /15.E2").has("51-1"));
assert.ok(tokens("-TB04.1x1H1").has("TB04"));
assert.ok(tokens("TBO1").has("TB01"));

assert.deepEqual(tagsIn("-KH1"), ["KH1"]);
assert.deepEqual(tagsIn("-X3.26"), []); // terminal, not a device
assert.deepEqual(tagsIn("-ON"), []);
assert.deepEqual(tagsIn("-47"), ["47"]); // device number alone
assert.deepEqual(tagsIn("-51-2"), ["51-2"]);
assert.deepEqual(tagsIn("1-WTIx1"), ["WTIX1"]);
assert.deepEqual(tagsIn("DC-125"), []);
assert.deepEqual(tagsIn("-WTIx1"), ["WTIX1"]);
assert.ok(tokens("-X3.26").has("X3"));
assert.ok(tokens("-SL1E").has("SL1"));

assert.equal(SC.fixBars("-K|0"), "-K10");
assert.equal(SC.fixBars("43|P"), "43IP");
assert.equal(SC.fixDigits("REM0TE"), "REMOTE");
assert.equal(SC.fixDigits("2-I0"), "2-10");
assert.equal(SC.fixDigits("-KH1"), "-KH1");

const g = new SC.Grid([[1, 50], [2, 150], [3, 250]], [["A", 50], ["B", 150]], [100, 200], [100]);
assert.deepEqual(g.zone(120, 40), ["A", 2]);
assert.deepEqual(g.zone(199, 160), ["B", 2]);
for (const z of ["A2", "A3", "B2", "B3"]) assert.ok(g.zones([190, 90, 210, 110]).has(z));

// a glyph matches itself
const lib = new SC.TemplateLibrary([["L", 0, [[0, 0, 0, 100, 60, 100]]], [null, 0, [[0, 0, 100, 100]]]]);
const r = lib.classify([[[0, 0], [0, 7], [4.2, 7]]]);
assert.equal(r.ch, "L");
assert.ok(r.score > 0.95);

// a BOM symbol part is found again turned, mirrored and at another scale
{
  const S = (pts) => new SC.Stroke(pts);
  const sym = [S([[10, 10], [30, 10], [30, 20], [10, 20], [10, 10]]), S([[10, 10], [30, 20]]), S([[15, 20], [15, 30]])];
  const bom = SC.packSegments(sym);
  const parts = SC.symbolParts(bom, [0, 0, 50, 50]);
  assert.equal(parts.length, 1);
  // the same drawing turned 90 degrees, mirrored and 1.5x larger, among other strokes
  const T = ([x, y]) => [300 + 1.5 * (20 - (y - 10)), 300 + 1.5 * (40 - (x - 10))];
  const page = SC.packSegments(sym.map((s) => S(s.pts.map(T))).concat([S([[250, 250], [400, 250]]), S([[260, 280], [260, 400]])]));
  const m = SC.matchPart(parts[0], bom, page, [240, 240, 420, 420]);
  assert.ok(m.score > 0.95, `score ${m.score}`);
  assert.ok(Math.abs(m.k - 1.5) < 0.05);
  // a different symbol in the same place does not match
  const other = SC.packSegments([S([[300, 300], [345, 300], [345, 330], [300, 330], [300, 300]])]);
  assert.ok(SC.matchPart(parts[0], bom, other, [240, 240, 420, 420]).score < 0.8);
}

// a terminal of the next table right after a reference is not part of its zone
{
  const ln = new SC.TextLine("4 /06.F3 3", 0, 0, 0, 60, 5, 5, []);
  const xs = SC._test.xrefs(ln);
  assert.equal(xs.length, 1);
  assert.equal(String(xs[0]), "/06.F3");
  assert.equal(String(SC._test.xrefs(new SC.TextLine("/06.E10", 0, 0, 0, 30, 5, 5, []))[0]), "/06.E10");
}

console.log("all unit tests passed");
