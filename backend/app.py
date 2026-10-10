"""Web app: upload a schematic PDF, run the checker, review findings with highlights.

Run:  uvicorn app:app --host 0.0.0.0 --port 8000   (from the backend directory)
"""
from __future__ import annotations

import csv
import io
import json
import os
import threading
import time
import traceback
import uuid
from pathlib import Path

import pymupdf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from schcheck.checker import analyse, check

DATA = Path(os.environ.get("SCHCHECK_DATA", Path(__file__).resolve().parent / "data"))
STATIC = Path(__file__).resolve().parent / "static"
MAX_UPLOAD = 200 * 1024 * 1024

app = FastAPI(title="Schematic Checker")
_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_queue = threading.Semaphore(1)  # one analysis at a time; each already uses every core


def _job_dir(job_id: str) -> Path:
    if not all(c in "0123456789abcdef" for c in job_id) or len(job_id) != 32:
        raise HTTPException(404, "ไม่พบงานนี้")
    d = DATA / job_id
    if not d.exists():
        raise HTTPException(404, "ไม่พบงานนี้")
    return d


def _run(job_id: str):
    d = DATA / job_id
    job = _jobs[job_id]
    with _queue:
        job["status"] = "running"
        job["started"] = time.time()
        try:
            def progress(done, total):
                job["progress"] = {"done": done, "total": total}

            pages = analyse(str(d / "input.pdf"), progress)
            report = check(pages).to_dict()
            report["file_name"] = job["file_name"]
            report["elapsed"] = round(time.time() - job["started"], 1)
            (d / "report.json").write_text(json.dumps(report, ensure_ascii=False))
            job["status"] = "done"
        except Exception as exc:  # report the failure to the page instead of hanging
            job["status"] = "error"
            job["error"] = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()


@app.post("/api/jobs")
async def create_job(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "ไฟล์ใหญ่เกินไป")
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "กรุณาอัปโหลดไฟล์ PDF")
    try:
        n = len(pymupdf.open(stream=data, filetype="pdf"))
    except Exception:
        raise HTTPException(400, "เปิดไฟล์ PDF ไม่ได้")
    job_id = uuid.uuid4().hex
    d = DATA / job_id
    d.mkdir(parents=True)
    (d / "input.pdf").write_bytes(data)
    name = Path(file.filename or "drawing.pdf").name
    with _lock:
        _jobs[job_id] = {"status": "queued", "progress": {"done": 0, "total": n}, "file_name": name}
    threading.Thread(target=_run, args=(job_id,), daemon=True).start()
    return {"id": job_id, "pages": n}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    d = _job_dir(job_id)
    job = _jobs.get(job_id)
    if job is None:  # finished in an earlier server run
        if (d / "report.json").exists():
            return {"status": "done", "report": json.loads((d / "report.json").read_text())}
        raise HTTPException(404, "ไม่พบงานนี้")
    out = {k: v for k, v in job.items() if k in ("status", "progress", "error", "file_name")}
    if job["status"] == "done":
        out["report"] = json.loads((d / "report.json").read_text())
    return out


@app.get("/api/jobs/{job_id}/pages/{page}.png")
def page_image(job_id: str, page: int, zoom: float = 1.5):
    d = _job_dir(job_id)
    zoom = max(0.5, min(zoom, 4.0))
    cache = d / f"page_{page}_{zoom:.2f}.png"
    if not cache.exists():
        doc = pymupdf.open(d / "input.pdf")
        if not 0 <= page < len(doc):
            raise HTTPException(404, "ไม่พบหน้านี้")
        pix = doc[page].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
        cache.write_bytes(pix.tobytes("png"))
    return FileResponse(cache, media_type="image/png", headers={"Cache-Control": "max-age=86400"})


def _report(d: Path) -> dict:
    if not (d / "report.json").exists():
        raise HTTPException(409, "ยังตรวจสอบไม่เสร็จ")
    return json.loads((d / "report.json").read_text())


@app.get("/api/jobs/{job_id}/annotated.pdf")
def annotated_pdf(job_id: str):
    d = _job_dir(job_id)
    rep = _report(d)
    doc = pymupdf.open(d / "input.pdf")
    colors = {"error": (0.86, 0.1, 0.1), "warning": (0.95, 0.55, 0.0)}
    for n, f in enumerate(rep["findings"], 1):
        for k, m in enumerate(f["marks"]):
            page = doc[m["page"]]
            r = pymupdf.Rect(m["bbox"]) * page.derotation_matrix
            r.normalize()
            a = page.add_rect_annot(r + (-1.5, -1.5, 1.5, 1.5))
            a.set_colors(stroke=colors.get(f["severity"], (1, 0, 0)))
            a.set_border(width=1.2)
            a.set_info(title=f"#{n} {f['code']}", content=f"{f['message']}\nแก้ไข: {f['fix']}")
            a.update()
    buf = doc.tobytes(garbage=3, deflate=True)
    name = Path(rep.get("file_name", "drawing.pdf")).stem + "_checked.pdf"
    return Response(buf, media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_quote(name)}"})


@app.get("/api/jobs/{job_id}/report.csv")
def report_csv(job_id: str):
    d = _job_dir(job_id)
    rep = _report(d)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["#", "ระดับ", "ประเภท", "หน้า PDF", "SHEET", "รายละเอียด", "สิ่งที่ต้องแก้ไข"])
    for n, f in enumerate(rep["findings"], 1):
        w.writerow([n, "ผิดพลาด" if f["severity"] == "error" else "เตือน", f["code"], f["page"] + 1,
                    f["sheet"] if f["sheet"] is not None else "", f["message"], f["fix"]])
    data = "﻿" + out.getvalue()  # BOM so Excel opens Thai text correctly
    name = Path(rep.get("file_name", "drawing.pdf")).stem + "_report.csv"
    return StreamingResponse(iter([data.encode("utf-8")]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_quote(name)}"})


def _quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s)


@app.get("/api/health")
def health():
    return JSONResponse({"ok": True})


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
