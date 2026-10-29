// Unit tests for the browser core:  node test/unit.mjs
import assert from "node:assert/strict";
import { loadCore } from "./load-core.mjs";

const SC = loadCore();
const { parseDesignations, parseSheetList, tagsIn, tokens } = SC._test;

assert.deepEqual(parseDesignations("QFM1. QFM2."), ["QFM1", "QFM2"]);
assert.deepEqual(parseDesignations("HR1-HR3"), ["HR1", "HR2", "HR3"]);
assert.deepEqual(parseDesignations("88F1.88F2,88FX1"), ["88F1", "88F2", "88FX1"]);
assert.deepEqual(parseSheetList("04. 09"), [4, 9]);
assert.deepEqual(parseSheetList("20-22"), [20, 21, 22]);

assert.deepEqual(tagsIn("-KH1"), ["KH1"]);
assert.deepEqual(tagsIn("-X3.26"), []); // terminal, not a device
assert.deepEqual(tagsIn("-ON"), []);
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

console.log("all unit tests passed");
