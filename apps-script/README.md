# Schematic Checker บน Google Apps Script

เวอร์ชันนี้ **ไม่ต้องมี server และไม่ต้องมี Google Cloud billing**
การอ่านแบบและการตรวจทั้งหมดทำใน browser ของผู้ใช้ (pdf.js + โค้ดตรวจที่เป็น JavaScript)
Apps Script ทำหน้าที่แค่ส่งหน้าเว็บ และบันทึกผลลง Google Sheets / Google Drive ของผู้ใช้เมื่อกดปุ่ม

ไฟล์ PDF ไม่ถูกส่งออกไปที่ใด ยกเว้นตอนกด "บันทึก PDF ลง Google Drive"

ทุกอย่างมาจากโปรเจค Apps Script เพียงที่เดียว ไลบรารีอ่าน PDF (pdf.js) และสร้าง PDF (pdf-lib)
ถูกรวมไว้ในโปรเจคแล้ว หน้าเว็บจึงไม่ดึงไฟล์จากเว็บไซต์อื่นเลย (ไม่ใช้ CDN และไม่ใช้ Google Fonts)

## ไฟล์ที่ต้องใช้

ไฟล์ที่พร้อมใช้อยู่ใน `dist/apps-script/`:

| ไฟล์ | หน้าที่ |
|---|---|
| `appsscript.json` | การตั้งค่าโปรเจค (manifest) |
| `Code.gs` | ฝั่ง server: ส่งหน้าเว็บ, บันทึกลง Sheets/Drive |
| `Index.html` | โครงหน้าเว็บ |
| `Styles.html` | หน้าตา (CSS) |
| `Core.html` | ตัวอ่านตัวอักษร SHX และตัวตรวจ |
| `Glyphs.html` | คลังรูปทรงตัวอักษร |
| `Ui.html` | การทำงานของหน้าเว็บ |
| `PdfJs1.html`, `PdfJs2.html` | ไลบรารี pdf.js สำหรับอ่าน PDF |
| `PdfWorker1.html` – `PdfWorker4.html` | ส่วนทำงานเบื้องหลังของ pdf.js |
| `PdfLib1.html`, `PdfLib2.html` | ไลบรารี pdf-lib สำหรับสร้าง PDF ที่ทำ highlight |

ไฟล์ไลบรารีเก็บเป็นข้อความเข้ารหัส (base64) บรรทัดละ 100 ตัวอักษร เพื่อให้วางใน editor ของ Apps Script ได้ครบ
และแบ่งไฟล์ไม่ให้ใหญ่เกิน 400 KB ถ้าไฟล์ใดวางไม่ครบ หน้าเว็บจะแจ้งชื่อไฟล์ที่ต้องวางใหม่

`dist/standalone.html` คือหน้าเดียวกันรวมเป็นไฟล์เดียว เปิดใน Chrome/Edge ได้เลยโดยไม่ต้องใช้ Apps Script
(ปุ่มบันทึกลง Google Sheets/Drive จะไม่แสดงในโหมดนี้)

## วิธีติดตั้งบน Apps Script (ผ่านหน้าเว็บ ไม่ต้องติดตั้งโปรแกรม)

1. เข้า https://script.google.com แล้วกด **New project** ตั้งชื่อเช่น `Schematic Checker`
2. ไปที่ **Project Settings** (รูปเฟือง) แล้วติ๊ก **Show "appsscript.json" manifest file in editor**
3. กลับมาที่ **Editor** แล้ว
   - เปิด `appsscript.json` แทนที่เนื้อหาด้วยไฟล์ `dist/apps-script/appsscript.json`
   - เปิด `Code.gs` แทนที่เนื้อหาด้วยไฟล์ `dist/apps-script/Code.gs`
   - กด **+** → **HTML** สร้างไฟล์ชื่อ `Index`, `Styles`, `Core`, `Glyphs`, `Ui`, `PdfJs1`, `PdfJs2`,
     `PdfWorker1`, `PdfWorker2`, `PdfWorker3`, `PdfWorker4`, `PdfLib1`, `PdfLib2`
     (พิมพ์ชื่อโดยไม่ต้องมี `.html` และต้องสะกดตรงตัวพิมพ์ใหญ่-เล็ก)
     แล้ววางเนื้อหาจากไฟล์ชื่อเดียวกันใน `dist/apps-script/` (รวม 13 ไฟล์ HTML)
     ไฟล์ไลบรารีมีขนาดไม่เกิน 400 KB การวางอาจใช้เวลาไม่กี่วินาที
4. กด **Save** (Ctrl+S)
5. กด **Deploy** → **New deployment** → เลือกประเภท **Web app**
   - **Execute as:** `User accessing the web app` (ผลจะถูกบันทึกลง Drive ของแต่ละคน)
   - **Who has access:** `Anyone with Google account` หรือ `Anyone within <ชื่อองค์กร>`
6. กด **Deploy** แล้วอนุญาตสิทธิ์ (Authorize access) จะได้ลิงก์ Web app (`https://script.google.com/macros/s/.../exec`)
   ส่งลิงก์นี้ให้ทีมใช้ได้เลย

ครั้งแรกที่ผู้ใช้แต่ละคนเปิด จะมีหน้าขออนุญาตใช้ Google Drive และ Google Sheets (ใช้เฉพาะตอนกดบันทึก)

### อัปเดตเวอร์ชัน

แก้ไฟล์แล้วไปที่ **Deploy** → **Manage deployments** → แก้ไข (รูปดินสอ) → **Version: New version** → **Deploy**
ลิงก์เดิมยังใช้ได้

ลิงก์ที่ลงท้ายด้วย `/exec` จะแสดงเวอร์ชันที่ Deploy ไว้ล่าสุด ถ้าเพียงแค่กด Save แต่ไม่ได้ Deploy เป็น New version
ลิงก์นี้จะยังเป็นโค้ดเดิม ถ้าต้องการลองโค้ดที่เพิ่ง Save ให้ใช้ **Deploy** → **Test deployments**
ซึ่งจะได้ลิงก์ที่ลงท้ายด้วย `/dev`

### ตรวจว่ากำลังใช้รุ่นไหน

ใต้ชื่อหน้าเว็บจะมีคำว่า "รุ่น xxxxxxxx" ซึ่งต้องตรงกับบรรทัด `const VERSION = "xxxxxxxx"` ใน `Ui.html` (ค้นด้วย Ctrl+F)
ถ้ามีไฟล์ใดในโปรเจกต์ยังเป็นรุ่นเก่า หน้าเว็บจะบอกชื่อไฟล์นั้นให้คัดลอกมาวางใหม่
ถ้าหน้าเว็บไม่มีคำว่า "รุ่น" เลย แปลว่าเบราว์เซอร์ยังได้ `Ui.html` / `Index.html` ชุดเก่า
ให้ตรวจไฟล์ทั้งสอง Deploy เป็น New version แล้วเปิดหน้าใหม่ด้วย Ctrl+F5 หรือหน้าต่างไม่ระบุตัวตน (Incognito)

## วิธีติดตั้งด้วย clasp (สำหรับผู้ที่ใช้ command line)

```bash
npm install -g @google/clasp
clasp login
cd dist/apps-script
clasp create --type webapp --title "Schematic Checker"
clasp push
clasp deploy
```

## การใช้งาน

1. เปิดลิงก์ Web app แล้วลากไฟล์ PDF ชุดแบบมาวาง
2. รอตรวจ (ไฟล์ 87 หน้าใช้เวลาประมาณ 20–40 วินาที ขึ้นกับเครื่อง)
3. คลิกรายการทางซ้ายเพื่อดูจุดบนแบบพร้อมกรอบ highlight
4. ดาวน์โหลด PDF ที่ทำ highlight / รายงาน CSV หรือบันทึกลง Google Sheets / Drive

ต้องใช้ browser รุ่นใหม่ (Chrome, Edge, Firefox, Safari) หน้าเว็บติดต่อเฉพาะ Google
(ตัว Web app และตอนกดบันทึกลง Sheets/Drive) จึงใช้ได้แม้เครือข่ายบริษัทจะบล็อกเว็บภายนอก

## สำหรับนักพัฒนา

โค้ดต้นฉบับอยู่ใน `src/` ส่วน `dist/` สร้างจากคำสั่ง build

```bash
npm install          # pdf.js และ pdf-lib สำหรับทดสอบใน Node
npm run build        # สร้าง dist/apps-script และ dist/standalone.html
node test/unit.mjs   # unit test
node test/run-node.mjs drawing.pdf report.json   # ตรวจไฟล์จาก command line
```

- `src/core/` — ตัวอ่านและตัวตรวจ (port มาจาก `backend/schcheck/` ที่เป็น Python)
- `src/ui/` — หน้าเว็บ
- `src/gas/` — โค้ดฝั่ง Apps Script
- `build.mjs` รวม pdf.js 3.11.174 และ pdf-lib 1.17.1 จาก `node_modules` เข้าไปในไฟล์ Apps Script
  (ใบอนุญาต: pdf.js — Apache License 2.0, pdf-lib — MIT; ข้อความใบอนุญาตอยู่ในหัวไฟล์ของแต่ละไลบรารี)
- `build-glyphs.mjs` — แปลงคลังตัวอักษร `backend/schcheck/data/glyphs.json` เป็น `build/glyphs.js`
  ถ้าเพิ่มตัวอักษรใหม่ด้วย `backend/tools/topup.py` ให้รัน `npm run build` ใหม่
