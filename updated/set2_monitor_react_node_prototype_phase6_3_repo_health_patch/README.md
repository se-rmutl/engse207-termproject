# ENGSE207 Set 2 Monitor — Phase 6.1

Phase 6.1 ปรับ workflow ของระบบ monitor ให้แสดงสถานะได้ชัดขึ้นทั้งฝั่งอาจารย์และนักศึกษา โดยเพิ่มแนวคิดต่อไปนี้:

- **Start status** ของกลุ่ม
  - `not_started` = ยังไม่เข้าใช้ระบบ
  - `logged_in` = เข้าแล้ว แต่ยังไม่ตั้งค่าสมาชิกครบ
  - `started` = ตั้งค่าสมาชิกแล้ว และเริ่มทำงานแล้ว
- **Student status**
  - `draft`
  - `in_progress`
  - `submitted_for_review`
  - `ready_for_interview`
- **Teacher status**
  - `not_checked`
  - `reviewing`
  - `needs_revision`
  - `verified`
  - `interview_scheduled`
  - `completed`
- **Recent update flag** สำหรับให้อาจารย์เห็นว่ามีนักศึกษาอัปเดตใหม่หลังการ review ล่าสุด
- **Readiness %** แยกจาก status ที่ผู้ใช้เลือกเอง

## บัญชีตัวอย่าง

- อาจารย์: `teacher / teacher123`
- กลุ่มตัวอย่าง: `sec1-group01 / group01pass`

ระบบเตรียม account กลุ่มไว้ล่วงหน้า:
- `sec1-group01 ... sec1-group20`
- `sec2-group01 ... sec2-group20`

## วิธีรัน

```bash
npm install
npm start
```

เปิดที่:

```text
http://localhost:8080
```

ถ้าจะเปลี่ยนพอร์ต:

```bash
PORT=8787 npm start
```

## จุดเด่นของ Phase 6.1

### ฝั่งอาจารย์
- การ์ดของแต่ละกลุ่มแสดงสถานะเริ่มต้นใช้งาน, สถานะนักศึกษา, สถานะอาจารย์ และตัวบอกอัปเดตใหม่
- แสดงตัวเลขสรุป `M/U/D/R`
  - `M` = สมาชิกกรอกแล้วกี่คน
  - `U` = URLs ครบกี่อัน
  - `D` = Documents ครบกี่อัน
  - `R` = Readiness %
- สามารถเปลี่ยน teacher status ย้อนกลับได้
- สามารถให้คะแนนและ review ได้ตามเดิม

### ฝั่งนักศึกษา
- login แบบกลุ่ม
- ตั้งค่าข้อมูลสมาชิกครั้งแรก
- เปลี่ยน student status ได้แบบย้อนกลับได้
- อัปเดต URLs / Documents / หมายเหตุถึงอาจารย์ได้
- เห็น feedback จากอาจารย์ได้

## หมายเหตุ

ระบบนี้ยังใช้ `better-sqlite3` เป็นฐานข้อมูลหลัก และใช้ SSE สำหรับอัปเดต realtime เมื่อข้อมูลกลุ่มเปลี่ยนแปลง
