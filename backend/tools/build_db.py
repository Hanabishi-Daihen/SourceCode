"""Build the glyph template library from labelled clusters.

usage: build_db.py clusters.json reps.json LABELS_DIR OUT.json

Label files (labels_XX.txt) hold one whitespace-separated token per representative,
in sheet order: a character, 'r'+character for vertical text, '~' for non-text.
Vertical glyphs are tested in both 90-degree directions against upright glyphs of
the same character to find which way the text reads.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np

from schcheck.glyphs import descriptor, rotate_upright

clusters = json.load(open(sys.argv[1]))
reps = json.load(open(sys.argv[2]))
tokens = []
for f in sorted(Path(sys.argv[3]).glob("labels_*.txt")):
    tokens.extend(f.read_text().split())
assert len(tokens) == len(reps), (len(tokens), len(reps))
# second pass: proposals (prop2.json) for reps2.json, corrected by fix2_*.txt ("idx:token")
lab = Path(sys.argv[3])
if (lab / "reps2.json").exists():
    reps2 = json.load(open(lab / "reps2.json"))
    prop2 = json.load(open(lab / "prop2.json"))
    for f in sorted(lab.glob("fix2_*.txt")):
        for item in f.read_text().split():
            k, tok = item.split(":", 1)
            prop2[int(k)] = tok
    reps = reps + reps2
    tokens = tokens + prop2

entries = []
for cid, tok in zip(reps, tokens):
    c = clusters[cid]
    if tok == "~":
        entries.append({"ch": None, "rot": 0, "polys": c["polys"]})
    elif tok.startswith("r") and len(tok) == 2:
        entries.append({"ch": tok[1], "rot": None, "polys": c["polys"]})
    else:
        entries.append({"ch": tok, "rot": 0, "polys": c["polys"]})

upright = {}
for e in entries:
    if e["ch"] and e["rot"] == 0:
        v, _, _, a = descriptor(e["polys"])
        upright.setdefault(e["ch"], []).append((v, a))

unresolved = 0
for e in entries:
    if e["rot"] is not None:
        continue
    best = (-9, 1)
    for rot in (1, 3):
        v, _, _, a = descriptor(rotate_upright(e["polys"], rot))
        for uv, ua in upright.get(e["ch"], []):
            s = float(uv @ v) - 0.5 * abs(np.log(ua / a))
            if s > best[0]:
                best = (s, rot)
    if best[0] < 0:
        unresolved += 1
    e["rot"] = best[1]
    e["score"] = round(best[0], 3)

json.dump(entries, open(sys.argv[4], "w"))
print(len(entries), "templates;", sum(1 for e in entries if e["ch"]), "text;",
      sum(1 for e in entries if e["rot"] == 1), "rot1;", sum(1 for e in entries if e["rot"] == 3), "rot3;",
      unresolved, "unresolved", file=sys.stderr)
