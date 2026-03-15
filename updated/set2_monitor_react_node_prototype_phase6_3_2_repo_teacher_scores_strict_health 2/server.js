const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'monitor.sqlite');
const AUTO_CHECK_MS = Number(process.env.AUTO_CHECK_MS || 60000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000);

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

function nowIso() { return new Date().toISOString(); }
function hashPassword(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }
function safeJsonParse(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }
function makeError(status, message) { const e = new Error(message); e.status = status; return e; }
function clampInt(v, min, max) {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function createSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    section TEXT NOT NULL,
    group_code TEXT NOT NULL,
    group_name TEXT NOT NULL,
    initialized INTEGER NOT NULL DEFAULT 0,
    members_json TEXT NOT NULL DEFAULT '[]',
    frontend_url TEXT DEFAULT '',
    auth_url TEXT DEFAULT '',
    task_url TEXT DEFAULT '',
    user_url TEXT DEFAULT '',
    readme_url TEXT DEFAULT '',
    team_split_url TEXT DEFAULT '',
    individual_report_url TEXT DEFAULT '',
    screenshots_url TEXT DEFAULT '',
    set1_repo_url TEXT DEFAULT '',
    set2_repo_url TEXT DEFAULT '',
    student_status TEXT DEFAULT 'draft',
    student_submitted_at TEXT DEFAULT '',
    student_ready_for_interview_at TEXT DEFAULT '',
    teacher_status TEXT DEFAULT 'not_checked',
    teacher_verified_at TEXT DEFAULT '',
    system_score INTEGER DEFAULT 0,
    docs_score INTEGER DEFAULT 0,
    interview_score INTEGER DEFAULT 0,
    bonus_score INTEGER DEFAULT 0,
    student_note TEXT DEFAULT '',
    teacher_feedback TEXT DEFAULT '',
    private_note TEXT DEFAULT '',
    services_json TEXT NOT NULL DEFAULT '{"frontend":{"ok":false,"statusCode":0,"label":"N/A"},"auth":{"ok":false,"statusCode":0,"label":"N/A"},"task":{"ok":false,"statusCode":0,"label":"N/A"},"user":{"ok":false,"statusCode":0,"label":"N/A"}}',
    last_checked_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_groups_section ON groups(section);
  CREATE INDEX IF NOT EXISTS idx_groups_teacher_status ON groups(teacher_status);
  CREATE INDEX IF NOT EXISTS idx_groups_student_status ON groups(student_status);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('teacher')),
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_accounts (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    group_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(group_id) REFERENCES groups(id)
  );
  `);

  const cols = db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name);
  const ensure = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE groups ADD COLUMN ${ddl}`); };
  ensure('last_student_login_at', 'last_student_login_at TEXT DEFAULT ""');
  ensure('last_student_update_at', 'last_student_update_at TEXT DEFAULT ""');
  ensure('last_teacher_review_at', 'last_teacher_review_at TEXT DEFAULT ""');
  ensure('set1_repo_url', 'set1_repo_url TEXT DEFAULT ""');
  ensure('set2_repo_url', 'set2_repo_url TEXT DEFAULT ""');
}
createSchema();

const runtime = {
  checkerEnabled: true,
  checkerRunning: false,
  checkerLastRunAt: '',
  checkerLastSummary: { checked: 0, okGroups: 0, stale: 0 }
};
const sessions = new Map();
const sseClients = new Set();

function parseGroupUsername(username) {
  const m = String(username || "").trim().toLowerCase().match(/^(sec[12])-(group\d{2})$/);
  if (!m) return null;
  const section = m[1];
  const groupCode = m[2];
  return { section, groupCode, id: `${section}-${groupCode}` };
}


function seedTeacher() {
  const now = nowIso();
  db.prepare(`
    INSERT INTO users (id, username, password_hash, role, display_name, created_at, updated_at)
    VALUES (@id, @username, @password_hash, 'teacher', @display_name, @created_at, @updated_at)
    ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, display_name=excluded.display_name, updated_at=excluded.updated_at
  `).run({
    id: 'teacher-main',
    username: 'teacher',
    password_hash: hashPassword('teacher123'),
    display_name: 'Instructor',
    created_at: now,
    updated_at: now
  });
}

function seedGroupsAndAccounts() {
  const now = nowIso();
  const insertGroup = db.prepare(`
    INSERT INTO groups (id, section, group_code, group_name, initialized, members_json, student_status, teacher_status, updated_at)
    VALUES (@id, @section, @group_code, @group_name, 0, '[]', 'draft', 'not_checked', @updated_at)
    ON CONFLICT(id) DO NOTHING
  `);
  const upsertAccount = db.prepare(`
    INSERT INTO group_accounts (username, password_hash, group_id, created_at, updated_at)
    VALUES (@username, @password_hash, @group_id, @created_at, @updated_at)
    ON CONFLICT(username) DO UPDATE SET
      password_hash=excluded.password_hash,
      group_id=excluded.group_id,
      updated_at=excluded.updated_at
  `);
  const fixDefaultName = db.prepare(`
    UPDATE groups SET group_name = @group_name
    WHERE id = @id AND (
      group_name = '' OR
      group_name IS NULL OR
      group_name = UPPER(REPLACE(id, '-', ' ')) OR
      group_name LIKE 'SEC% GROUP%'
    )
  `);
  const tx = db.transaction(() => {
    for (const sec of ['sec1', 'sec2']) {
      for (let i = 1; i <= 20; i += 1) {
        const groupCode = `group${String(i).padStart(2, '0')}`;
        const id = `${sec}-${groupCode}`;
        const groupName = `${sec.toUpperCase()} ${groupCode.toUpperCase()}`;
        insertGroup.run({ id, section: sec, group_code: groupCode, group_name: groupName, updated_at: now });
        upsertAccount.run({
          username: id,
          password_hash: hashPassword(`${groupCode}pass`),
          group_id: id,
          created_at: now,
          updated_at: now
        });
        fixDefaultName.run({ id, group_name: groupName });
      }
    }
  });
  tx();
}

seedTeacher();
seedGroupsAndAccounts();

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1));
  });
  return out;
}
function createSession(user) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return sid;
}
function getSession(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}
function clearSession(req) {
  const sid = parseCookies(req).sid;
  if (sid) sessions.delete(sid);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(makeError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}
function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}
function requireSession(req) { const s = getSession(req); if (!s) throw makeError(401, 'Unauthorized'); return s; }
function requireTeacher(req) { const s = requireSession(req); if (s.user.role !== 'teacher') throw makeError(403, 'Teacher only'); return s; }
function requireStudent(req) { const s = requireSession(req); if (s.user.role !== 'student') throw makeError(403, 'Student group only'); return s; }

function normalizeMembers(members) {
  const arr = Array.isArray(members) ? members : [];
  return arr.slice(0, 3).map((m) => ({
    studentId: String(m.studentId || '').trim(),
    fullName: String(m.fullName || '').trim()
  })).filter((m) => m.studentId || m.fullName);
}

function statusTimestampPatch(studentStatus, existingRow) {
  const patch = { student_status: studentStatus };
  if (studentStatus === 'submitted_for_review') patch.student_submitted_at = nowIso();
  else if (studentStatus !== 'ready_for_interview' && existingRow?.student_submitted_at && studentStatus === 'draft') patch.student_submitted_at = existingRow.student_submitted_at;
  if (studentStatus === 'ready_for_interview') patch.student_ready_for_interview_at = nowIso();
  else if (studentStatus !== 'ready_for_interview' && existingRow?.student_ready_for_interview_at && ['draft', 'in_progress', 'submitted_for_review'].includes(studentStatus)) patch.student_ready_for_interview_at = existingRow.student_ready_for_interview_at;
  return patch;
}

function computeReadiness(row, services, urlsCount, docsCount, memberCount) {
  let score = 0;
  score += Math.min(15, memberCount * 5);
  score += Math.min(20, urlsCount * 5);
  score += Math.min(20, docsCount * 5);
  score += Object.values(services).filter((s) => s && s.ok).length * 10;
  score += row.initialized ? 10 : 0;
  score += row.student_status === 'submitted_for_review' ? 10 : 0;
  score += row.student_status === 'ready_for_interview' ? 15 : 0;
  score += ['verified', 'interview_scheduled', 'completed'].includes(row.teacher_status) ? 5 : 0;
  return Math.max(0, Math.min(100, score));
}

function toPublicGroup(row, viewerRole = 'teacher') {
  const members = safeJsonParse(row.members_json, []);
  const services = safeJsonParse(row.services_json, {});
  const urls = {
    frontend: row.frontend_url || '',
    auth: row.auth_url || '',
    task: row.task_url || '',
    user: row.user_url || ''
  };
  const docs = {
    readme: row.readme_url || '',
    teamSplit: row.team_split_url || '',
    individualReport: row.individual_report_url || '',
    screenshots: row.screenshots_url || ''
  };
  const repoUrls = {
    set1: row.set1_repo_url || '',
    set2: row.set2_repo_url || ''
  };
  const docsCount = Object.values(docs).filter(Boolean).length;
  const repoCount = Object.values(repoUrls).filter(Boolean).length;
  const urlsCount = Object.values(urls).filter(Boolean).length;
  const servicesOk = Object.values(services).filter((s) => s && s.ok).length;
  const memberCount = members.filter((m) => m.studentId || m.fullName).length;
  const profileCompleted = !!row.initialized && memberCount >= 2;
  const hasLoggedIn = !!row.last_student_login_at;
  const startState = !hasLoggedIn ? 'not_started' : (!profileCompleted ? 'logged_in' : 'started');
  const hasRecentUpdate = !!row.last_student_update_at && (!row.last_teacher_review_at || new Date(row.last_student_update_at).getTime() > new Date(row.last_teacher_review_at).getTime());
  const readiness = computeReadiness(row, services, urlsCount, docsCount, memberCount);
  const readinessLevel = readiness >= 85 ? 'complete' : readiness >= 60 ? 'high' : readiness >= 35 ? 'medium' : 'low';
  const item = {
    id: row.id,
    section: row.section,
    groupCode: row.group_code,
    groupName: row.group_name,
    initialized: !!row.initialized,
    members,
    memberCount,
    urls,
    docs,
    repoUrls,
    profileCompleted,
    hasLoggedIn,
    startState,
    hasRecentUpdate,
    studentStatus: row.student_status,
    studentSubmittedAt: row.student_submitted_at,
    studentReadyForInterviewAt: row.student_ready_for_interview_at,
    teacherStatus: row.teacher_status,
    teacherVerifiedAt: row.teacher_verified_at,
    systemScore: row.system_score || 0,
    docsScore: row.docs_score || 0,
    interviewScore: row.interview_score || 0,
    bonusScore: row.bonus_score || 0,
    totalScore: (row.system_score || 0) + (row.docs_score || 0) + (row.interview_score || 0),
    studentNote: row.student_note || '',
    teacherFeedback: row.teacher_feedback || '',
    services,
    servicesOk,
    urlsCount,
    docsCount,
    repoCount,
    readiness,
    readinessLevel,
    lastCheckedAt: row.last_checked_at || '',
    updatedAt: row.updated_at || '',
    lastStudentLoginAt: row.last_student_login_at || '',
    lastStudentUpdateAt: row.last_student_update_at || '',
    lastTeacherReviewAt: row.last_teacher_review_at || ''
  };
  if (viewerRole === 'teacher') item.privateNote = row.private_note || '';
  return item;
}

function getAllGroups(role = 'teacher') {
  return db.prepare('SELECT * FROM groups ORDER BY section ASC, group_code ASC').all().map((r) => toPublicGroup(r, role));
}
function getGroupById(id, role = 'teacher') {
  const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  return row ? toPublicGroup(row, role) : null;
}

const upsertGroupStmt = db.prepare(`
  UPDATE groups SET
    group_name=@group_name,
    initialized=@initialized,
    members_json=@members_json,
    frontend_url=@frontend_url,
    auth_url=@auth_url,
    task_url=@task_url,
    user_url=@user_url,
    readme_url=@readme_url,
    team_split_url=@team_split_url,
    individual_report_url=@individual_report_url,
    screenshots_url=@screenshots_url,
    set1_repo_url=@set1_repo_url,
    set2_repo_url=@set2_repo_url,
    student_status=@student_status,
    student_submitted_at=@student_submitted_at,
    student_ready_for_interview_at=@student_ready_for_interview_at,
    teacher_status=@teacher_status,
    teacher_verified_at=@teacher_verified_at,
    system_score=@system_score,
    docs_score=@docs_score,
    interview_score=@interview_score,
    bonus_score=@bonus_score,
    student_note=@student_note,
    teacher_feedback=@teacher_feedback,
    private_note=@private_note,
    services_json=@services_json,
    last_checked_at=@last_checked_at,
    updated_at=@updated_at,
    last_student_login_at=@last_student_login_at,
    last_student_update_at=@last_student_update_at,
    last_teacher_review_at=@last_teacher_review_at
  WHERE id=@id
`);

function mergeAndSaveGroup(id, patch) {
  const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!row) throw makeError(404, 'Group not found');
  const next = {
    ...row,
    group_name: patch.group_name ?? row.group_name,
    initialized: patch.initialized ?? row.initialized,
    members_json: JSON.stringify(patch.members ?? safeJsonParse(row.members_json, [])),
    frontend_url: patch.frontend_url ?? row.frontend_url,
    auth_url: patch.auth_url ?? row.auth_url,
    task_url: patch.task_url ?? row.task_url,
    user_url: patch.user_url ?? row.user_url,
    readme_url: patch.readme_url ?? row.readme_url,
    team_split_url: patch.team_split_url ?? row.team_split_url,
    individual_report_url: patch.individual_report_url ?? row.individual_report_url,
    screenshots_url: patch.screenshots_url ?? row.screenshots_url,
    set1_repo_url: patch.set1_repo_url ?? row.set1_repo_url,
    set2_repo_url: patch.set2_repo_url ?? row.set2_repo_url,
    student_status: patch.student_status ?? row.student_status,
    student_submitted_at: patch.student_submitted_at ?? row.student_submitted_at,
    student_ready_for_interview_at: patch.student_ready_for_interview_at ?? row.student_ready_for_interview_at,
    teacher_status: patch.teacher_status ?? row.teacher_status,
    teacher_verified_at: patch.teacher_verified_at ?? row.teacher_verified_at,
    system_score: clampInt(patch.system_score ?? row.system_score, 0, 90),
    docs_score: clampInt(patch.docs_score ?? row.docs_score, 0, 5),
    interview_score: clampInt(patch.interview_score ?? row.interview_score, 0, 5),
    bonus_score: Math.max(0, clampInt(patch.bonus_score ?? row.bonus_score, 0, 999)),
    student_note: patch.student_note ?? row.student_note,
    teacher_feedback: patch.teacher_feedback ?? row.teacher_feedback,
    private_note: patch.private_note ?? row.private_note,
    services_json: JSON.stringify(patch.services ?? safeJsonParse(row.services_json, {})),
    last_checked_at: patch.last_checked_at ?? row.last_checked_at,
    updated_at: nowIso(),
    last_student_login_at: patch.last_student_login_at ?? row.last_student_login_at,
    last_student_update_at: patch.last_student_update_at ?? row.last_student_update_at,
    last_teacher_review_at: patch.last_teacher_review_at ?? row.last_teacher_review_at
  };
  upsertGroupStmt.run(next);
  const saved = getGroupById(id, 'teacher');
  broadcastSnapshot();
  return saved;
}

function markStudentLoggedIn(groupId) {
  mergeAndSaveGroup(groupId, { last_student_login_at: nowIso() });
}

function loginTeacher(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  if (user.password_hash !== hashPassword(password)) return null;
  return { role: 'teacher', username: user.username, displayName: user.display_name };
}
function loginGroup(username, password) {
  const acc = db.prepare('SELECT * FROM group_accounts WHERE username = ?').get(username);
  if (!acc) return null;
  if (acc.password_hash !== hashPassword(password)) return null;
  const canonical = parseGroupUsername(username);
  const wantedId = canonical?.id || acc.group_id;
  if (canonical && acc.group_id !== wantedId) {
    db.prepare('UPDATE group_accounts SET group_id = ?, updated_at = ? WHERE username = ?').run(wantedId, nowIso(), username);
  }
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(wantedId) || db.prepare('SELECT * FROM groups WHERE id = ?').get(acc.group_id);
  if (!group) return null;
  return {
    role: 'student',
    username: acc.username,
    displayName: group.group_name,
    groupId: group.id,
    section: group.section,
    groupCode: group.group_code
  };
}

function deriveHealthUrl(kind, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/\/health\/?$/i.test(raw)) return raw;
  if (kind === 'frontend') return raw;
  if (kind === 'auth') return raw.replace(/\/$/, '') + '/api/auth/health';
  if (kind === 'task') return raw.replace(/\/$/, '') + '/api/tasks/health';
  if (kind === 'user') return raw.replace(/\/$/, '') + '/api/users/health';
  return raw;
}
function isRepoHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host.includes('github.com') || host.includes('raw.githubusercontent.com') || host.includes('gitlab.com') || host.includes('bitbucket.org');
}
function httpCheck(kind, targetUrl) {
  return new Promise((resolve) => {
    if (!targetUrl) return resolve({ ok: false, statusCode: 0, label: 'MISSING' });
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return resolve({ ok: false, statusCode: 0, label: 'BAD URL' }); }
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(targetUrl, { method: 'GET', timeout: 6000, headers: { 'User-Agent': 'ENGSE207-Monitor/1.0', 'Accept': 'application/json, text/html;q=0.9, */*;q=0.8' } }, (resp) => {
      let body = '';
      resp.setEncoding('utf8');
      resp.on('data', (chunk) => { body += chunk; if (body.length > 32768) body = body.slice(0, 32768); });
      resp.on('end', () => {
        const statusCode = resp.statusCode || 0;
        const contentType = String(resp.headers['content-type'] || '').toLowerCase();
        if (kind === 'frontend') {
          if (isRepoHost(parsed.hostname)) return resolve({ ok: false, statusCode, label: 'REPO URL' });
          const htmlLike = contentType.includes('text/html') || body.trim().length > 0;
          const bodyLower = body.toLowerCase();
          const appLike = bodyLower.includes('<html') || bodyLower.includes('<body') || bodyLower.includes('react') || bodyLower.includes('app');
          const ok = statusCode >= 200 && statusCode < 400 && htmlLike && appLike;
          return resolve({ ok, statusCode, label: ok ? 'OK' : (statusCode ? `HTTP ${statusCode}` : 'ERR') });
        }
        let parsedJson = null;
        try { parsedJson = JSON.parse(body || '{}'); } catch {}
        const expectedService = kind === 'auth' ? 'auth-service' : kind === 'task' ? 'task-service' : kind === 'user' ? 'user-service' : '';
        const statusOk = parsedJson && String(parsedJson.status || '').toLowerCase() === 'ok';
        const serviceOk = parsedJson && String(parsedJson.service || '') === expectedService;
        const ok = statusCode >= 200 && statusCode < 400 && statusOk && serviceOk;
        let label = 'ERR';
        if (ok) label = 'OK';
        else if (!parsedJson) label = statusCode ? `HTTP ${statusCode}` : 'ERR';
        else if (!statusOk) label = 'BAD STATUS';
        else if (!serviceOk) label = 'BAD SERVICE';
        else if (statusCode) label = `HTTP ${statusCode}`;
        return resolve({ ok, statusCode, label });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, statusCode: 0, label: 'ERR' }));
    req.end();
  });
}
async function checkGroupHealth(id) {
  const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!row) throw makeError(404, 'Group not found');
  const checks = {
    frontend: deriveHealthUrl('frontend', row.frontend_url),
    auth: deriveHealthUrl('auth', row.auth_url),
    task: deriveHealthUrl('task', row.task_url),
    user: deriveHealthUrl('user', row.user_url)
  };
  const [frontend, auth, task, user] = await Promise.all([
    httpCheck('frontend', checks.frontend), httpCheck('auth', checks.auth), httpCheck('task', checks.task), httpCheck('user', checks.user)
  ]);
  return mergeAndSaveGroup(id, { services: { frontend, auth, task, user }, last_checked_at: nowIso() });
}
async function checkAllGroups() {
  const ids = db.prepare('SELECT id FROM groups').all().map((r) => r.id);
  runtime.checkerRunning = true;
  let checked = 0;
  for (const id of ids) {
    try { await checkGroupHealth(id); checked += 1; } catch {}
  }
  runtime.checkerRunning = false;
  runtime.checkerLastRunAt = nowIso();
  runtime.checkerLastSummary = { checked, okGroups: getAllGroups('teacher').filter((g) => g.servicesOk >= 3).length, stale: 0 };
  broadcastMeta();
}
setInterval(() => { if (runtime.checkerEnabled) checkAllGroups().catch(() => {}); }, AUTO_CHECK_MS).unref();

function writeCsv(groups) {
  const headers = ['id','section','groupCode','groupName','startState','memberCount','urlsCount','docsCount','repoCount','studentStatus','teacherStatus','systemScore','docsScore','interviewScore','bonusScore','readiness','set1RepoUrl','set2RepoUrl','frontendUrl','authUrl','taskUrl','userUrl'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...groups.map((g) => [
    g.id, g.section, g.groupCode, g.groupName, g.startState, g.memberCount, g.urlsCount, g.docsCount, g.repoCount, g.studentStatus, g.teacherStatus,
    g.systemScore, g.docsScore, g.interviewScore, g.bonusScore, g.readiness, g.repoUrls.set1, g.repoUrls.set2, g.urls.frontend, g.urls.auth, g.urls.task, g.urls.user
  ].map(esc).join(','))].join('\n');
}
function getMetaPayload() {
  return {
    checker: {
      enabled: runtime.checkerEnabled,
      running: runtime.checkerRunning,
      intervalMs: AUTO_CHECK_MS,
      lastRunAt: runtime.checkerLastRunAt,
      lastSummary: runtime.checkerLastSummary
    }
  };
}
function sendSse(client, type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  try { client.res.write(data); } catch { sseClients.delete(client); }
}
function broadcastSnapshot() {
  for (const client of sseClients) {
    if (client.role === 'teacher') sendSse(client, 'snapshot', { items: getAllGroups('teacher'), meta: getMetaPayload() });
    else sendSse(client, 'snapshot', { item: studentOwnGroup({ user: client.user }), meta: getMetaPayload() });
  }
}
function broadcastMeta() {
  for (const client of sseClients) {
    sendSse(client, 'meta', { meta: getMetaPayload() });
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendText(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'application/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}
function studentOwnGroup(session) {
  const canonical = parseGroupUsername(session?.user?.username);
  const wantedId = canonical?.id || session?.user?.groupId;
  return getGroupById(wantedId, 'student') || getGroupById(session?.user?.groupId, 'student');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/api/stream') {
      const session = getSession(req);
      if (!session) return sendJson(res, 401, { error: 'Unauthorized' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      const client = { res, role: session.user.role, user: session.user };
      if (session.user.role === 'teacher') sendSse(client, 'snapshot', { items: getAllGroups('teacher'), meta: getMetaPayload() });
      else sendSse(client, 'snapshot', { item: studentOwnGroup(session), meta: getMetaPayload() });
      sseClients.add(client);
      req.on('close', () => sseClients.delete(client));
      return;
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = loginTeacher(username, password) || loginGroup(username, password);
      if (!user) throw makeError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      const sid = createSession(user);
      if (user.role === 'student') markStudentLoggedIn(user.groupId);
      return sendJson(res, 200, { user }, { 'Set-Cookie': `sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; SameSite=Lax` });
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      clearSession(req);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
    }
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const session = getSession(req);
      if (!session) throw makeError(401, 'Unauthorized');
      return sendJson(res, 200, { user: session.user });
    }

    if (pathname === '/api/meta' && req.method === 'GET') {
      requireSession(req);
      return sendJson(res, 200, getMetaPayload());
    }
    if (pathname === '/api/meta/checker' && req.method === 'POST') {
      requireTeacher(req);
      const body = await readBody(req);
      runtime.checkerEnabled = !!body.enabled;
      broadcastMeta();
      return sendJson(res, 200, getMetaPayload());
    }

    if (pathname === '/api/groups' && req.method === 'GET') {
      requireTeacher(req);
      return sendJson(res, 200, { items: getAllGroups('teacher') });
    }
    if (pathname === '/api/export' && req.method === 'GET') {
      requireTeacher(req);
      return sendJson(res, 200, getAllGroups('teacher'));
    }
    if (pathname === '/api/export.csv' && req.method === 'GET') {
      requireTeacher(req);
      return sendText(res, 200, writeCsv(getAllGroups('teacher')), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="set2-monitor.csv"'
      });
    }
    if (pathname === '/api/check-all' && req.method === 'POST') {
      requireTeacher(req);
      await checkAllGroups();
      return sendJson(res, 200, { ok: true, meta: getMetaPayload() });
    }

    const mGroupCheck = pathname.match(/^\/api\/groups\/([^/]+)\/check-health$/);
    if (mGroupCheck && req.method === 'POST') {
      requireTeacher(req);
      const item = await checkGroupHealth(decodeURIComponent(mGroupCheck[1]));
      return sendJson(res, 200, { item });
    }
    const mReview = pathname.match(/^\/api\/groups\/([^/]+)\/review$/);
    if (mReview && req.method === 'PATCH') {
      requireTeacher(req);
      const id = decodeURIComponent(mReview[1]);
      const body = await readBody(req);
      const teacherStatus = String(body.teacherStatus || 'not_checked');
      const patch = {
        teacher_status: teacherStatus,
        teacher_verified_at: ['verified', 'interview_scheduled', 'completed'].includes(teacherStatus) ? nowIso() : '',
        teacher_feedback: String(body.teacherFeedback || ''),
        private_note: String(body.privateNote || ''),
        system_score: body.systemScore,
        docs_score: body.docsScore,
        interview_score: body.interviewScore,
        bonus_score: body.bonusScore,
        last_teacher_review_at: nowIso()
      };
      const item = mergeAndSaveGroup(id, patch);
      return sendJson(res, 200, { item });
    }
    const mGroup = pathname.match(/^\/api\/groups\/([^/]+)$/);
    if (mGroup && req.method === 'GET') {
      requireTeacher(req);
      const item = getGroupById(decodeURIComponent(mGroup[1]), 'teacher');
      if (!item) throw makeError(404, 'Group not found');
      return sendJson(res, 200, { item });
    }

    if (pathname === '/api/me/group' && req.method === 'GET') {
      const session = requireStudent(req);
      return sendJson(res, 200, { item: studentOwnGroup(session) });
    }
    if (pathname === '/api/me/group/setup' && req.method === 'PATCH') {
      const session = requireStudent(req);
      const body = await readBody(req);
      const members = normalizeMembers(body.members);
      if (members.length < 2) throw makeError(400, 'ต้องมีสมาชิกอย่างน้อย 2 คน');
      const item = mergeAndSaveGroup(session.user.groupId, {
        initialized: 1,
        members,
        group_name: String(body.groupName || `${session.user.section.toUpperCase()} ${session.user.groupCode.toUpperCase()}`).trim() || `${session.user.section.toUpperCase()} ${session.user.groupCode.toUpperCase()}`,
        last_student_update_at: nowIso()
      });
      return sendJson(res, 200, { item: getGroupById(item.id, 'student') });
    }
    if (pathname === '/api/me/group/submission' && req.method === 'PATCH') {
      const session = requireStudent(req);
      const body = await readBody(req);
      const item = mergeAndSaveGroup(session.user.groupId, {
        frontend_url: String(body.frontendUrl || ''),
        auth_url: String(body.authUrl || ''),
        task_url: String(body.taskUrl || ''),
        user_url: String(body.userUrl || ''),
        readme_url: String(body.readmeUrl || ''),
        team_split_url: String(body.teamSplitUrl || ''),
        individual_report_url: String(body.individualReportUrl || ''),
        screenshots_url: String(body.screenshotsUrl || ''),
        set1_repo_url: String(body.set1RepoUrl || ''),
        set2_repo_url: String(body.set2RepoUrl || ''),
        student_note: String(body.studentNote || ''),
        last_student_update_at: nowIso()
      });
      return sendJson(res, 200, { item: getGroupById(item.id, 'student') });
    }
    if (pathname === '/api/me/group/status' && req.method === 'PATCH') {
      const session = requireStudent(req);
      const body = await readBody(req);
      const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(session.user.groupId);
      const studentStatus = String(body.studentStatus || 'draft');
      const patch = { ...statusTimestampPatch(studentStatus, row), last_student_update_at: nowIso() };
      const item = mergeAndSaveGroup(session.user.groupId, patch);
      return sendJson(res, 200, { item: getGroupById(item.id, 'student') });
    }
    if (pathname === '/api/me/group/note' && req.method === 'PATCH') {
      const session = requireStudent(req);
      const body = await readBody(req);
      const item = mergeAndSaveGroup(session.user.groupId, { student_note: String(body.studentNote || ''), last_student_update_at: nowIso() });
      return sendJson(res, 200, { item: getGroupById(item.id, 'student') });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.status || 500;
    return sendJson(res, status, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Set2 monitor Phase 6.1 running at http://localhost:${PORT}`);
});
