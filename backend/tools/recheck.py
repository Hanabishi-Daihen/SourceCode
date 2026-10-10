"""Re-run only the cross-sheet checks on cached page analysis (debug aid).

usage: recheck.py FILE.pdf CACHE.pkl   (cache is created on first run)
"""
import pickle
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from schcheck.checker import analyse, check


def main():
    cache = Path(sys.argv[2])
    if cache.exists():
        pages = pickle.loads(cache.read_bytes())
    else:
        pages = analyse(sys.argv[1])
        cache.write_bytes(pickle.dumps(pages))
    rep = check(pages)
    print(rep.stats, file=sys.stderr)
    for f in rep.findings:
        print(f"[{f.severity}] p{f.page + 1} s{f.sheet} {f.code}: {f.message}  => {f.fix}")


if __name__ == "__main__":
    main()
