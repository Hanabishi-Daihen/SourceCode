import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from schcheck.model import XREF, Grid, _parse_designations, _parse_sheet_list, _tags_in, _tokens
from schcheck.ocr import _fix_bars


def test_xref_pattern():
    m = XREF.search("4 7/24.C4")
    assert m and m.groups() == ("24", "C", "4")
    assert XREF.search("/07.D10").groups() == ("07", "D", "10")


def test_designations_and_ranges():
    assert _parse_designations("QFM1. QFM2.") == ["QFM1", "QFM2"]
    assert _parse_designations("HR1-HR3") == ["HR1", "HR2", "HR3"]
    assert _parse_designations("88F1.88F2,88FX1") == ["88F1", "88F2", "88FX1"]


def test_sheet_lists():
    assert _parse_sheet_list("04. 09") == [4, 9]
    assert _parse_sheet_list("20-22") == [20, 21, 22]


def test_tags():
    assert _tags_in("-KH1") == ["KH1"]
    assert _tags_in("-X3.26") == []  # terminal, not a device
    assert _tags_in("-ON") == []
    assert _tags_in("-WTIx1") == ["WTIX1"]
    assert "X3" in _tokens("-X3.26")
    assert "SL1" in _tokens("-SL1E")


def test_bars_become_one_or_i():
    assert _fix_bars("-K|0") == "-K10"
    assert _fix_bars("43|P") == "43IP"


def test_grid_zones_with_ticks():
    g = Grid([(1, 50), (2, 150), (3, 250)], [("A", 50), ("B", 150)], [100, 200], [100])
    assert g.zone(120, 40) == ("A", 2)
    assert g.zone(199, 160) == ("B", 2)
    assert g.zones((190, 90, 210, 110)) >= {("A", 2), ("A", 3), ("B", 2), ("B", 3)}
