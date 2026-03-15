# ENGSE207 Set 2 Monitor — Final Usable

ระบบติดตามความคืบหน้าของ Final Lab Set 2 สำหรับวิชา ENGSE207

มี 3 มุมมองหลัก
- `/board` — public board สำหรับทั้งห้องดูความคืบหน้า
- `/login` — หน้า login
- `/teacher` — dashboard สำหรับอาจารย์
- `/student` — workspace สำหรับนักศึกษา (หลัง login)

## คุณสมบัติหลัก
- login แบบกลุ่ม เช่น `sec1-group01 / group01pass`
- teacher dashboard พร้อมคะแนน, review, feedback, private note
- public board แบบ read-only
- SQLite persistence
- SSE realtime updates
- health check แบบ strict
- mock health สำหรับทดลองผ่าน `http://localhost:8080/mock/health`
- audit log / history การแก้ไข

## เริ่มใช้งานในเครื่อง
```bash
npm install
npm start
```

เปิดที่
- http://localhost:8080/board
- http://localhost:8080/login
- http://localhost:8080/teacher

บัญชีตัวอย่าง
- teacher / teacher123
- sec1-group01 / group01pass
- sec2-group20 / group20pass

## ตัวแปรแวดล้อม
- `PORT` พอร์ตของแอป
- `DATA_DIR` โฟลเดอร์เก็บ SQLite และข้อมูลถาวร
- `AUTO_CHECK_MS` ช่วงเวลา auto health check
- `SESSION_TTL_MS` อายุ session

ตัวอย่าง
```bash
PORT=8080 DATA_DIR=./data AUTO_CHECK_MS=60000 npm start
```

## Railway
แนะนำให้ mount volume ที่ `/app/data` และตั้ง
- `DATA_DIR=/app/data`
- `AUTO_CHECK_MS=60000`
- `SESSION_TTL_MS=28800000`

จากนั้น deploy service นี้จาก GitHub แล้ว Generate Domain

## หมายเหตุ
- public board ไม่แสดง private note และคะแนนละเอียด
- student เห็นเฉพาะกลุ่มของตนเอง
- teacher เห็นครบทุกกลุ่ม
