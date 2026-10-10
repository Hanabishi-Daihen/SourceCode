"use strict";

const $ = (id) => document.getElementById(id);
const TYPE_LABEL = {
  COIL_TABLE_ZONE: "ตารางใต้ coil: ตำแหน่ง contact ไม่ตรง",
  COIL_TABLE_MISSING: "ตารางใต้ coil: ไม่พบ contact",
  XREF_SHEET_MISSING: "อ้างถึง SHEET ที่ไม่มี",
  BACKREF_ZONE: "contact: ตำแหน่ง coil ไม่ตรง",
  BACKREF_NOT_FOUND: "contact: ไม่พบอุปกรณ์ที่อ้างถึง",
  BACKREF_SHEET_MISSING: "contact: อ้างถึง SHEET ที่ไม่มี",
  CONTACT_NOT_LISTED: "contact ไม่อยู่ในตารางใต้ coil",
  BOM_NOT_ON_SHEET: "BOM: SHEET ไม่ตรง",
  BOM_NOT_FOUND: "BOM: ไม่พบอุปกรณ์",
  BOM_SHEET_MISSING: "BOM: SHEET ที่ไม่มี",
  BOM_SHEET_UNUSED: "BOM: SHEET ไม่มีอุปกรณ์ในแถว",
  NOT_IN_BOM: "ไม่มีใน BOM",
};
const ZOOM_RENDER = 2; // page images are rendered at this scale; the view scales them

const state = {
  jobId: null,
  report: null,
  sev: "all",
  type: "all",
  query: "",
  selected: null,
  page: 0,
  scale: 1,
};

// ---------------------------------------------------------------- upload
const drop = $("drop");
$("fileInput").addEventListener("change", (e) => e.target.files[0] && upload(e.target.files[0]));
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]));
$("newCheck").addEventListener("click", () => { history.replaceState(null, "", location.pathname); location.reload(); });

function showError(msg) {
  $("uploadError").textContent = msg;
  $("uploadError").hidden = false;
  $("progress").hidden = true;
}

async function upload(file) {
  $("uploadError").hidden = true;
  $("progress").hidden = false;
  setProgress("กำลังอัปโหลด…", 0, 1);
  const fd = new FormData();
  fd.append("file", file);
  let res;
  try {
    res = await fetch("api/jobs", { method: "POST", body: fd });
  } catch {
    return showError("อัปโหลดไม่สำเร็จ ตรวจสอบการเชื่อมต่อ");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return showError(body.detail || "อัปโหลดไม่สำเร็จ");
  state.jobId = body.id;
  history.replaceState(null, "", `?job=${body.id}`);
  poll();
}

function setProgress(text, done, total) {
  $("progressText").textContent = text;
  $("progressCount").textContent = total > 1 ? `${done} / ${total} หน้า` : "";
  $("progressFill").style.width = `${total ? (100 * done) / total : 0}%`;
}

async function poll() {
  const res = await fetch(`api/jobs/${state.jobId}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return showError(body.detail || "ไม่พบงานนี้");
  if (body.status === "error") return showError(`ตรวจสอบไม่สำเร็จ: ${body.error}`);
  if (body.status === "done") return showReport(body.report);
  $("progress").hidden = false;
  const p = body.progress || { done: 0, total: 0 };
  setProgress(body.status === "queued" ? "รอคิว…" : "กำลังอ่านแบบและตรวจสอบ…", p.done, p.total);
  setTimeout(poll, 1000);
}

// ---------------------------------------------------------------- report
function showReport(report) {
  state.report = report;
  report.findings.forEach((f, i) => (f.n = i + 1));
  $("uploadView").hidden = true;
  $("resultView").hidden = false;
  $("exportActions").hidden = false;
  $("dlPdf").href = `api/jobs/${state.jobId}/annotated.pdf`;
  $("dlCsv").href = `api/jobs/${state.jobId}/report.csv`;

  const s = report.stats;
  $("summary").innerHTML = `
    <div class="stat err"><div class="n">${s.errors}</div><div class="l">ผิดพลาด</div></div>
    <div class="stat warn"><div class="n">${s.warnings}</div><div class="l">เตือน</div></div>
    <div class="stat"><div class="n">${s.pages}</div><div class="l">หน้า</div></div>
    <div class="stat"><div class="n">${s.coils}</div><div class="l">coil (${s.contact_rows} contact)</div></div>
    <div class="stat"><div class="n">${s.contacts}</div><div class="l">contact ที่อ้าง coil</div></div>
    <div class="stat"><div class="n">${s.bom_designations}</div><div class="l">อุปกรณ์ใน BOM</div></div>
    <div class="file-line" title="${esc(report.file_name || "")}">${esc(report.file_name || "")} · ใช้เวลา ${report.elapsed ?? "-"} วินาที</div>`;

  const types = [...new Set(report.findings.map((f) => f.code))];
  $("typeFilter").innerHTML = `<option value="all">ทุกประเภท</option>` +
    types.map((t) => `<option value="${t}">${esc(TYPE_LABEL[t] || t)}</option>`).join("");

  $("pageSelect").innerHTML = report.pages.map((p) => {
    const n = report.findings.filter((f) => f.marks.some((m) => m.page === p.index)).length;
    const label = p.sheet != null ? `หน้า ${p.index + 1} · SHEET ${pad(p.sheet)}` : `หน้า ${p.index + 1}`;
    return `<option value="${p.index}">${label}${n ? ` (${n})` : ""}</option>`;
  }).join("");

  renderList();
  const first = filtered()[0];
  if (first) select(first.n); else showPage(0);
}

function filtered() {
  const q = state.query.trim().toUpperCase().replace(/^-/, "");
  return state.report.findings.filter((f) =>
    (state.sev === "all" || f.severity === state.sev) &&
    (state.type === "all" || f.code === state.type) &&
    (!q || (f.message + " " + f.fix).toUpperCase().includes(q)));
}

function renderList() {
  const items = filtered();
  const el = $("findings");
  if (!items.length) {
    el.innerHTML = `<li class="empty">${state.report.findings.length ? "ไม่มีรายการตามตัวกรอง" : "ไม่พบจุดที่ต้องแก้ไข ✓"}</li>`;
    return;
  }
  el.innerHTML = items.map((f) => `
    <li class="finding${f.n === state.selected ? " sel" : ""}" data-n="${f.n}">
      <div class="meta">
        <span class="badge ${f.severity}">${f.severity === "error" ? "ผิดพลาด" : "เตือน"}</span>
        <span>#${f.n}</span><span>หน้า ${f.page + 1}${f.sheet != null ? ` · SHEET ${pad(f.sheet)}` : ""}</span>
        <span>${esc(TYPE_LABEL[f.code] || f.code)}</span>
      </div>
      <div class="msg">${esc(f.message)}</div>
      <div class="fix">→ ${esc(f.fix)}</div>
    </li>`).join("");
}

$("findings").addEventListener("click", (e) => {
  const li = e.target.closest(".finding");
  if (li) select(+li.dataset.n);
});
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
  state.sev = b.dataset.sev;
  renderList();
}));
$("typeFilter").addEventListener("change", (e) => { state.type = e.target.value; renderList(); });
$("search").addEventListener("input", (e) => { state.query = e.target.value; renderList(); });

function select(n, markIndex = 0) {
  state.selected = n;
  const f = state.report.findings[n - 1];
  document.querySelectorAll(".finding").forEach((li) => li.classList.toggle("sel", +li.dataset.n === n));
  const mark = f.marks[markIndex] || f.marks[0];
  const cur = $("current");
  cur.hidden = false;
  cur.className = `current ${f.severity}`;
  const others = f.marks.length > 1
    ? ` · ตำแหน่งที่เกี่ยวข้อง: ${f.marks.map((m, i) => `<a href="#" data-mi="${i}">หน้า ${m.page + 1}</a>`).join(", ")}`
    : "";
  cur.innerHTML = `<b>#${f.n}</b> ${esc(f.message)} <span class="fix">→ ${esc(f.fix)}</span>${others}`;
  cur.querySelectorAll("a[data-mi]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    select(n, +a.dataset.mi);
  }));
  showPage(mark ? mark.page : f.page, mark);
}

// ---------------------------------------------------------------- viewer
$("pageSelect").addEventListener("change", (e) => showPage(+e.target.value));
$("zoomIn").addEventListener("click", () => setScale(state.scale * 1.25));
$("zoomOut").addEventListener("click", () => setScale(state.scale / 1.25));
$("zoomFit").addEventListener("click", () => fit());

function pageMeta(i) { return state.report.pages[i]; }

function showPage(i, focus) {
  const changed = state.page !== i || !$("pageImg").src;
  state.page = i;
  $("pageSelect").value = String(i);
  const img = $("pageImg");
  const p = pageMeta(i);
  const draw = () => {
    if (!state.fitted) fit(); else applyScale();
    drawMarks(focus);
    if (focus) scrollTo(focus);
  };
  if (changed) {
    img.onload = draw;
    img.src = `api/jobs/${state.jobId}/pages/${i}.png?zoom=${ZOOM_RENDER}`;
    img.width = p.width * ZOOM_RENDER;
  } else {
    draw();
  }
}

function fit() {
  const p = pageMeta(state.page);
  const box = $("canvas");
  state.fitted = true;
  setScale((box.clientWidth - 32) / p.width);
}

function setScale(s) {
  state.scale = Math.max(0.3, Math.min(s, 6));
  applyScale();
  drawMarks();
}

function applyScale() {
  const p = pageMeta(state.page);
  const img = $("pageImg");
  img.style.width = `${p.width * state.scale}px`;
  img.style.height = `${p.height * state.scale}px`;
  $("zoomText").textContent = `${Math.round(state.scale * 100)}%`;
}

function drawMarks(focus) {
  const p = pageMeta(state.page);
  const svg = $("overlay");
  svg.setAttribute("viewBox", `0 0 ${p.width} ${p.height}`);
  const sel = state.report.findings[state.selected - 1];
  const parts = [];
  for (const f of state.report.findings) {
    for (const m of f.marks) {
      if (m.page !== state.page) continue;
      const [x0, y0, x1, y1] = m.bbox;
      const isSel = f === sel;
      const isFocus = focus && m === focus;
      const cls = `mark ${f.severity}${isSel ? "" : " other"}${isFocus ? " focus" : ""}`;
      parts.push(`<rect class="${cls}" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="1.5" vector-effect="non-scaling-stroke"/>`);
    }
  }
  // selected marks on top
  parts.sort((a, b) => (a.includes(" other") ? 0 : 1) - (b.includes(" other") ? 0 : 1));
  svg.innerHTML = parts.join("");
}

function scrollTo(m) {
  const c = $("canvas");
  const [x0, y0, x1, y1] = m.bbox;
  const cx = ((x0 + x1) / 2) * state.scale;
  const cy = ((y0 + y1) / 2) * state.scale;
  if (state.scale < 1.6) setScale(1.8);
  c.scrollTo({
    left: ((x0 + x1) / 2) * state.scale - c.clientWidth / 2 + 16,
    top: ((y0 + y1) / 2) * state.scale - c.clientHeight / 2 + 16,
    behavior: "smooth",
  });
  void cx; void cy;
}

// ---------------------------------------------------------------- utils
function pad(n) { return String(n).padStart(2, "0"); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// resume a job from the URL (?job=...)
const fromUrl = new URLSearchParams(location.search).get("job");
if (fromUrl) { state.jobId = fromUrl; poll(); }
