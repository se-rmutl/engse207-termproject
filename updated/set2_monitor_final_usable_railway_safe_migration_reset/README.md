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


## Safe migration และการป้องกันข้อมูลหาย
ระบบนี้ใช้ SQLite และออกแบบให้ **redeploy โดยข้อมูลไม่หาย** ตราบใดที่คุณยังเก็บไฟล์ฐานข้อมูลไว้ใน path เดิม และ Railway service นี้มี **Volume** แบบ persistent

แนวทางในโค้ด:
- สร้างตารางด้วย `CREATE TABLE IF NOT EXISTS`
- เพิ่มคอลัมน์ใหม่แบบ additive ด้วย `ALTER TABLE ... ADD COLUMN` เฉพาะคอลัมน์ที่ยังไม่มี
- ไม่ลบตารางหรือเคลียร์ข้อมูลอัตโนมัติระหว่าง deploy ปกติ

### สำคัญมากบน Railway
- ต้อง mount **Volume** และตั้ง `DATA_DIR=/app/data`
- อย่าเก็บ SQLite ไว้บน filesystem ชั่วคราวของ container
- อย่าตั้ง `RESET_DB=true` ในการ deploy ปกติ

### ถ้าต้องการ init DB ใหม่จริง ๆ
ระบบรองรับ env ต่อไปนี้:
- `RESET_DB=true` → ลบไฟล์ SQLite เดิมแล้วสร้างใหม่
- `RESET_DB_BACKUP=true` → สำรองไฟล์ DB เดิมเป็น `monitor.backup.<timestamp>.sqlite` ก่อน reset (ค่าเริ่มต้นคือ `true`)

ตัวอย่างการรีเซ็ตครั้งเดียว:
```bash
RESET_DB=true npm start
```

หลังจาก init ใหม่แล้ว ให้เอา `RESET_DB` ออกทันที หรือกลับเป็น `false` เพื่อป้องกันการล้าง DB ซ้ำรอบถัดไป

### ตัวอย่างค่าที่แนะนำบน Railway
```text
DATA_DIR=/app/data
AUTO_CHECK_MS=60000
SESSION_TTL_MS=28800000
RESET_DB=false
RESET_DB_BACKUP=true
```

### ข้อควรระวัง
- ถ้าเปลี่ยน `DATA_DIR` หรือ path ของ SQLite ระหว่าง deploy ระบบอาจมองเหมือนเป็น DB ใหม่
- ถ้าไม่มี Volume ข้อมูลอาจหายเมื่อ service ถูก rebuild/redeploy
- ถ้าต้องการ reset จริง ควร export/backup ก่อนทุกครั้ง
