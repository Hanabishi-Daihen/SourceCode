"""Run the checker on a PDF and print findings.  usage: run_check.py FILE.pdf [out.json]"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from schcheck.checker import run



def main():
    t = time.time()
    rep = run(sys.argv[1], lambda i, n: print(f"\r{i}/{n}", end="", file=sys.stderr))
    print(f"\n{time.time() - t:.1f}s", rep.stats, file=sys.stderr)
    for f in rep.findings:
        print(f"[{f.severity}] p{f.page + 1} s{f.sheet} {f.code}: {f.message}  => {f.fix}")
    if len(sys.argv) > 2:
        json.dump(rep.to_dict(), open(sys.argv[2], "w"), ensure_ascii=False)


if __name__ == "__main__":
    main()
