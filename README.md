# Schematic Checker

เว็บแอปตรวจสอบแบบ Schematic diagram (PDF ที่ plot จาก AutoCAD) ว่าตำแหน่งอุปกรณ์และ contact ถูกต้องหรือไม่
แล้ว highlight จุดที่ผิดพร้อมบอกว่าต้องแก้เป็นอะไร

## สิ่งที่ตรวจ

| การตรวจ | ตัวอย่าง |
|---|---|
| ตารางใต้ coil ต้องชี้ไปยังตำแหน่ง contact จริง | `-KH1`: `4 —/— 7 /24.C4` → ต้องมี contact `-KH1` ที่ SHEET 24 ช่อง C4 |
| ตำแหน่ง coil ที่เขียนข้าง contact ต้องถูก | contact `-KH1 /16.G2` → coil `-KH1` ต้องอยู่ที่ SHEET 16 ช่อง G2 |
| contact ทุกตัวต้องอยู่ในตารางใต้ coil | contact `-KS1` ที่ `/16.E4` ต้องมีแถว `/16.E4` ในตารางของ coil `-KS1` |
| BOM | อุปกรณ์แต่ละตัวต้องปรากฏใน SHEET ที่ระบุในช่อง SCHEMATIC DIAGRAM |

ผลลัพธ์: รายการจุดผิด (ผิดพลาด / เตือน), ดูตำแหน่งบนแบบพร้อม highlight,
ดาวน์โหลด PDF ที่มีกรอบ highlight + comment และรายงาน CSV (เปิดใน Excel ได้)

## วิธีทำงาน (ทำไมอ่าน PDF ที่ข้อความเป็นเส้นได้)

AutoCAD plot ฟอนต์ SHX ออกมาเป็นเส้น ไม่ใช่ตัวอักษร โปรแกรมจึง:

1. ดึงเส้นทั้งหมดจาก PDF แล้วรวมเส้นที่ต่อกันเป็น "ตัวอักษร" (`schcheck/strokes.py`)
2. เทียบรูปทรงกับคลังแม่แบบตัวอักษรที่สร้างจากแบบจริง (`schcheck/data/glyphs.json`)
   รองรับข้อความแนวนอนและแนวตั้งทั้งสองทิศ (`schcheck/ocr.py`)
3. รวมกับข้อความจริงใน PDF (ฟอนต์ TrueType, แบบของผู้ผลิตอื่น)
4. หาเลข SHEET / เลขที่แบบ (series เช่น `CD-PP1005B-4S`) และตาราง zone จาก tick ที่ขอบแบบ
5. หา coil + ตาราง contact, contact + back-reference, แถว BOM แล้วตรวจไขว้กัน (`schcheck/model.py`, `schcheck/checker.py`)

เลข SHEET นับใหม่ในแต่ละชุดแบบ (4C / 4T / 4S) การอ้างอิงจึงตรวจภายในชุดเดียวกัน

## ติดตั้งและรัน

```bash
cd backend
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

เปิด http://localhost:8000 แล้วอัปโหลด PDF

หรือใช้ Docker:

```bash
docker build -t schematic-checker backend
docker run -p 8000:8000 schematic-checker
```

ตรวจจาก command line:

```bash
python backend/tools/run_check.py drawing.pdf report.json
```

## เพิ่มฟอนต์ใหม่ในคลังตัวอักษร

ถ้าแบบใช้ฟอนต์ที่ยังไม่มีในคลัง ตัวอักษรบางตัวอาจอ่านผิด เพิ่มได้ดังนี้:

```bash
cd backend
python tools/topup.py scan /tmp/top new_drawing.pdf:1-40   # หารูปทรงที่ยังไม่รู้จัก -> top_XX.png
# ดูภาพ top_XX.png แล้วแก้ label ที่ผิดในไฟล์ /tmp/top/fix_00.txt  เช่น "12:R 15:~"
#   ('~' = ไม่ใช่ตัวอักษร, 'rX' = ตัว X ในข้อความแนวตั้ง)
python tools/topup.py apply /tmp/top
```

## ข้อจำกัดที่ทราบ

- ตำแหน่งของ contact/coil คำนวณจากรูปสัญลักษณ์ข้างชื่ออุปกรณ์ ถ้าสัญลักษณ์คร่อมเส้นแบ่ง zone จะยอมรับทั้งสองช่อง
- อุปกรณ์ที่ไม่มีตาราง contact (เช่น MCB, thermostat) ใช้ตำแหน่งของชื่ออุปกรณ์และกรอบสัญลักษณ์ที่ติดกัน
- ผลลัพธ์ควรให้วิศวกรตรวจทานก่อนแก้แบบ โดยเฉพาะรายการระดับ "เตือน"

## ทดสอบ

```bash
cd backend && python -m pytest -q tests
```
