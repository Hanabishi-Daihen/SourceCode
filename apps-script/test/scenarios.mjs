// The regression drawing set: every drawing convention met so far, with known mistakes.
//
// Each block says which real drawing the case came from.  `expected` lists the findings
// the checker must report, and nothing else may be reported.
import { Sheet } from "./synth.mjs";

export function build() {
  const s5 = new Sheet(5), s6 = new Sheet(6), s7 = new Sheet(7), s8 = new Sheet(8), s50 = new Sheet(50);
  const expected = [];
  const expect = (code, ...has) => expected.push({ code, has });
  const zones = []; // [tag, sheet, zone]: where a contact must be located
  const located = (tag, sheet, zone) => zones.push([tag, sheet, zone]);

  // 1. plain relay: one row right, one row a column off (PP1006D -KL2: /09.F8 for a contact in F7)
  s5.coil("K1", "G1", [["13", "14", "/06.C1"], ["23", "24", "/06.C2"]], { label: "FAN START" });
  s6.contact("K1", "C1", "/05.G1", ["13", "14"]);
  s6.contact("K1", "C3", "/05.G1", ["23", "24"]);
  expect("COIL_TABLE_ZONE", "-K1", "23-24", "/06.C2", "แก้ /06.C2 เป็น /06.C3");

  // 2. the contact names the wrong coil position (PP1006D -88F4: /07.G4 for a coil in G3)
  s5.coil("K2", "G2", [["13", "14", "/06.E1"]]);
  s6.contact("K2", "E1", "/05.G3", ["13", "14"]);
  expect("BACKREF_ZONE", "-K2", "/05.G3", "แก้ /05.G3 เป็น /05.G2");

  // 3. latching relay drawn as two boxes, next to another coil (PP1006D -LKL beside -KL7)
  s5.coil("LKL", "G4", [["4", "3", "/06.E3"], ["8", "9", "/06.E4"]], { double: true, label: "FAN SET" });
  s5.coil("K7", "G5", [["5", "9", "/06.E5"]], { fx: 0.62, label: "FAN" });
  s6.contact("LKL", "E3", "/05.G4", ["4", "3"]);
  s6.contact("LKL", "E4", "/05.G4", ["8", "9"]);
  s6.contact("K7", "E5", "/05.G5", ["5", "9"]);

  // 4. two tables so close that a reference is followed by the next table's terminal
  //    ("/06.F3 3" must not become /06.F33)
  s5.coil("K3", "G7", [["1", "2", "/06.F3"], ["3", "4", "/06.F3"]], { fx: 0.15, tableDx: 12 });
  s5.coil("K5", "G7", [["1", "2", "/06.F5"], ["3", "4", "/06.F5"]], { fx: 0.15 + 78 / 107.1, tableDx: -12 });
  s6.contact("K3", "F3", "/05.G7", ["1", "2"]);
  s6.contact("K5", "F5", "/05.G7", ["1", "2"]);

  // 5. the table names the wrong sheet; the contact with those terminals is elsewhere
  //    (PP1006D -88FX1: /06.E5 for contacts on sheet 05; PP1005B -KS1: /14.E4 for /16.E4)
  s5.coil("K8", "G9", [["1", "2", "/07.E6"]]);
  s6.contact("K8", "E6", "/05.G9", ["1", "2"]);
  expect("COIL_TABLE_ZONE", "-K8", "/07.E6", "แก้ /07.E6 เป็น /06.E6");

  // 6. a table row for a sheet that is not in the set
  s5.coil("K9", "G10", [["13", "14", "/33.A1"]], { fx: 0.45 });
  expect("XREF_SHEET_MISSING", "-K9", "SHEET 33");

  // 7. relay drawn as an outline with its number inside and the table above it, next to
  //    a breaker (PP1043A -47 beside -QL1)
  s5.coil("47", "C2", [["11", "14", "/06.A2"], ["21", "22", "/06.A3"]], { inside: true, tableAbove: true, fx: 0.4 });
  s5.breaker("QL1", "C3", [], { fx: 0.35, fy: 0.45 });
  s6.contact("47", "A2", "/05.C2", ["11", "14"]);
  s6.contact("47", "A3", "/05.C2", ["21", "22"]);

  // 8. wires leaving the sheet are not contact references (PP1005B "DC+.2 > /18.A1")
  s5.arrow(1120, 100, "/06.A1");
  s5.arrow(40, 300, "/04.D6", { left: true });
  s5.dashed(1090, 60, 1090, 700); // a dashed frame line passing by
  s6.arrow(40, 100, "/05.A10", { left: true });

  // 9. a contact that no row of its coil's table points at, while the table's own row is fine
  s7.coil("K6", "G2", [["13", "14", "/06.C9"]]);
  s6.contact("K6", "C9", "/07.G2", ["13", "14"]);
  s6.contact("K6", "C10", "/07.G2", ["43", "44"], { fx: 0.45 });
  expect("CONTACT_NOT_LISTED", "-K6", "/06.C10");

  // 10. back-references to a sheet that does not exist / a sheet without the device
  s6.contact("KX1", "G8", "/44.B2", ["13", "14"]);
  expect("BACKREF_SHEET_MISSING", "-KX1", "SHEET 44");
  s6.contact("KX2", "G9", "/07.B2", ["13", "14"]);
  expect("BACKREF_NOT_FOUND", "-KX2", "/07.B2");

  // 11. a label written without the dash (PP1005B "51-1" over "/15.E2")
  s7.coil("51-1", "E2", [["14", "11", "/06.A6"]]);
  s6.contact("51-1", "A6", "/07.E2", ["14", "11"], { dash: false });

  // 12. a label written vertically (PP1006D -26WL)
  s7.coil("26WL", "C8", [["24", "21", "/06.A8"]]);
  s6.contact("26WL", "A8", "/07.C8", ["24", "21"], { vertical: true });

  // 13. breaker whose poles reach into the next zone, with an auxiliary contact drawn
  //     sideways and labelled above it, a wire of the next zone close by (QM8 cases)
  s7.breaker("QM8", "E4", [["21", "22", "/08.E4"]], { fx: 0.72 });
  s8.contactSideways("QM8", "E4", "/07.E5", ["22", "21"], { fx: 0.55 });
  { const z = Sheet.zone("E5"); s8.line([z.x0 + 4, z.y0 - 60], [z.x0 + 4, z.y1 + 60]); }
  located("QM8", 8, "E4");

  // 14. equipment list with a symbol per row: the reference points at the symbol
  //     (PP1043A -HL /50.E7); one that points into another row is wrong
  s50.text(500, 62, "DESTINATION", 7);
  s50.text(820, 62, "POSITION IN SCHEMATIC", 7);
  // the row rules are drawn cell by cell, as table grids often are
  for (const y of [90, 300, 440, 575]) for (const [a, b] of [[80, 130], [130, 495], [495, 600], [600, 1110]]) s50.line([a, y], [b, y]);
  // inside a row, a rule over its last line: more than half the sheet wide, but it starts
  // at the name column
  for (const y of [278, 418, 550]) s50.line([495, y], [1110, y]);
  s50.text(505, 425, "-23HL", 7.3);
  s50.text(505, 556, "-HL", 7.3);
  { const [x, y] = Sheet.at("E8"); s50.rect(x - 4, y - 16, x + 4, y + 16).line([x, y - 30], [x, y - 16]).line([x, y + 16], [x, y + 30]); }
  s8.contact("HL", "G6", "/50.E8", ["1", "2"]);
  s8.contact("23HL", "F6", "/50.G8", ["1", "2"]);
  expect("BACKREF_ZONE", "-23HL", "/50.G8");

  // 14b. the same kind of list recognised without its headings, by the "12/G6" positions
  const s51 = new Sheet(51);
  for (const y of [90, 230, 370, 510]) s51.line([80, y], [1110, y]);
  [["-FL", 215, "08/C6"], ["-CONL", 355, "08/D6"], ["-92L", 495, "08/E6"]].forEach(([name, y, pos]) => {
    s51.text(700, y, name, 7.3);
    s51.text(800, y, "SHEET", 6);
    s51.text(880, y, pos, 6);
  });
  { const [x, y] = Sheet.at("B8"); s51.rect(x - 4, y - 12, x + 4, y + 12); }
  s8.contact("FL", "C6", "/51.B8", ["1", "2"]);
  s8.contact("CONL", "D6", "/51.B8", ["1", "2"]); // B8 is in the row of -FL, not of -CONL
  expect("BACKREF_ZONE", "-CONL", "/51.B8");

  // 16. the breaker's rating between its name and its reference to the equipment list
  //     (PP1043A: -QL1 / 32A. / /49.B7)
  { const [x, y] = Sheet.at("C3", 0.35, 0.45); s5.text(x, y + 6, "32A.", 5.5, { align: "right" }); s5.text(x, y + 14, "/50.B8", 7, { align: "right" }); }
  s50.text(505, 285, "-QL1", 7.3);

  // 17. a contact table with no device near it is reported as unchecked, not skipped
  s7.tableRow(900, 150, "13", "14", "/06.B5");
  s7.tableRow(900, 158.2, "23", "24", "/06.B6");
  expect("TABLE_NO_COIL", "2 แถว", "/06.B5");

  // 15. a second drawing series in the same file: sheet numbers start again and a name
  //     used there is another device (terminal drawings CD-...-4T next to CD-...-4S)
  const t5 = new Sheet(5, { series: "CD-PPTEST-4T" }), t6 = new Sheet(6, { series: "CD-PPTEST-4T" });
  t5.coil("K1", "G5", [["13", "14", "/06.B2"]]);
  t6.contact("K1", "B2", "/05.G5", ["13", "14"]);

  return { sheets: [t5, t6, s5, s6, s7, s8, s50, s51], expected, zones };
}
