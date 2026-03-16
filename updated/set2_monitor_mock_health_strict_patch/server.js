
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'monitor.sqlite');
const LEGACY_JSON_FILE = path.join(DATA_DIR, 'groups.json');
const AUTO_CHECK_MS = Number(process.env.AUTO_CHECK_MS || 60000);

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    group_name TEXT NOT NULL,
    members_json TEXT NOT NULL DEFAULT '[]',
    repo_url TEXT DEFAULT '',
    readme_url TEXT DEFAULT '',
    frontend_url TEXT DEFAULT '',
    auth_url TEXT DEFAULT '',
    task_url TEXT DEFAULT '',
    user_url TEXT DEFAULT '',
    status TEXT DEFAULT 'draft',
    interview_status TEXT DEFAULT 'pending',
    system_score INTEGER DEFAULT 0,
    docs_score INTEGER DEFAULT 0,
    interview_score INTEGER DEFAULT 0,
    bonus_score INTEGER DEFAULT 0,
    student_feedback TEXT DEFAULT '',
    private_note TEXT DEFAULT '',
    checklist_json TEXT NOT NULL DEFAULT '{"readme":false,"teamSplit":false,"individualReport":false,"screenshots":false}',
    services_json TEXT NOT NULL DEFAULT '{"frontend":{"ok":false,"statusCode":0,"label":"N/A"},"auth":{"ok":false,"statusCode":0,"label":"N/A"},"task":{"ok":false,"statusCode":0,"label":"N/A"},"user":{"ok":false,"statusCode":0,"label":"N/A"}}',
    last_checked_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_groups_updated_at ON groups(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_groups_status ON groups(status);
  CREATE INDEX IF NOT EXISTS idx_groups_interview_status ON groups(interview_status);
`);

const runtime = {
  checkerEnabled: true,
  checkerRunning: false,
  checkerLastRunAt: '',
  checkerLastSummary: { checked: 0, ready: 0, partial: 0, failed: 0, draft: 0 }
};

const sseClients = new Set();

const stmt = {
  count: db.prepare('SELECT COUNT(*) AS c FROM groups'),
  
  // FIXED: Wrapped the query in backticks so the single quotes inside COALESCE work correctly
  all: db.prepare(`SELECT * FROM groups ORDER BY datetime(COALESCE(updated_at, '')) DESC, group_name ASC`),
  
  byId: db.prepare('SELECT * FROM groups WHERE id = ?'),
  deleteById: db.prepare('DELETE FROM groups WHERE id = ?'),
  clear: db.prepare('DELETE FROM groups'),
  upsert: db.prepare(`
    INSERT INTO groups (
      id, group_name, members_json, repo_url, readme_url, frontend_url, auth_url, task_url, user_url,
      status, interview_status, system_score, docs_score, interview_score, bonus_score,
      student_feedback, private_note, checklist_json, services_json, last_checked_at, updated_at
    ) VALUES (
      @id, @group_name, @members_json, @repo_url, @readme_url, @frontend_url, @auth_url, @task_url, @user_url,
      @status, @interview_status, @system_score, @docs_score, @interview_score, @bonus_score,
      @student_feedback, @private_note, @checklist_json, @services_json, @last_checked_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      group_name=excluded.group_name,
      members_json=excluded.members_json,
      repo_url=excluded.repo_url,
      readme_url=excluded.readme_url,
      frontend_url=excluded.frontend_url,
      auth_url=excluded.auth_url,
      task_url=excluded.task_url,
      user_url=excluded.user_url,
      status=excluded.status,
      interview_status=excluded.interview_status,
      system_score=excluded.system_score,
      docs_score=excluded.docs_score,
      interview_score=excluded.interview_score,
      bonus_score=excluded.bonus_score,
      student_feedback=excluded.student_feedback,
      private_note=excluded.private_note,
      checklist_json=excluded.checklist_json,
      services_json=excluded.services_json,
      last_checked_at=excluded.last_checked_at,
      updated_at=excluded.updated_at
  `)
};

function safeJsonParse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function hydrateRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    groupName: row.group_name,
    members: safeJsonParse(row.members_json, []),
    repoUrl: row.repo_url || '',
    readmeUrl: row.readme_url || '',
    frontendUrl: row.frontend_url || '',
    authUrl: row.auth_url || '',
    taskUrl: row.task_url || '',
    userUrl: row.user_url || '',
    status: row.status || 'draft',
    interviewStatus: row.interview_status || 'pending',
    systemScore: Number(row.system_score) || 0,
    docsScore: Number(row.docs_score) || 0,
    interviewScore: Number(row.interview_score) || 0,
    bonusScore: Number(row.bonus_score) || 0,
    studentFeedback: row.student_feedback || '',
    privateNote: row.private_note || '',
    checklist: safeJsonParse(row.checklist_json, { readme: false, teamSplit: false, individualReport: false, screenshots: false }),
    services: safeJsonParse(row.services_json, {
      frontend: { ok: false, statusCode: 0, label: 'N/A' },
      auth: { ok: false, statusCode: 0, label: 'N/A' },
      task: { ok: false, statusCode: 0, label: 'N/A' },
      user: { ok: false, statusCode: 0, label: 'N/A' }
    }),
    lastCheckedAt: row.last_checked_at || '',
    updatedAt: row.updated_at || ''
  };
}

function normalizeGroup(input = {}) {
  return {
    id: input.id || `g-${Math.random().toString(36).slice(2, 9)}`,
    groupName: input.groupName || 'New Group',
    members: Array.isArray(input.members) ? input.members : [],
    repoUrl: input.repoUrl || '',
    readmeUrl: input.readmeUrl || '',
    frontendUrl: input.frontendUrl || '',
    authUrl: input.authUrl || '',
    taskUrl: input.taskUrl || '',
    userUrl: input.userUrl || '',
    status: input.status || 'draft',
    interviewStatus: input.interviewStatus || 'pending',
    systemScore: Number(input.systemScore) || 0,
    docsScore: Number(input.docsScore) || 0,
    interviewScore: Number(input.interviewScore) || 0,
    bonusScore: Number(input.bonusScore) || 0,
    studentFeedback: input.studentFeedback || '',
    privateNote: input.privateNote || '',
    checklist: input.checklist || { readme: false, teamSplit: false, individualReport: false, screenshots: false },
    services: input.services || {
      frontend: { ok: false, statusCode: 0, label: 'N/A' },
      auth: { ok: false, statusCode: 0, label: 'N/A' },
      task: { ok: false, statusCode: 0, label: 'N/A' },
      user: { ok: false, statusCode: 0, label: 'N/A' }
    },
    lastCheckedAt: input.lastCheckedAt || '',
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

function rowParams(group) {
  const g = normalizeGroup(group);
  return {
    id: g.id,
    group_name: g.groupName,
    members_json: JSON.stringify(g.members || []),
    repo_url: g.repoUrl || '',
    readme_url: g.readmeUrl || '',
    frontend_url: g.frontendUrl || '',
    auth_url: g.authUrl || '',
    task_url: g.taskUrl || '',
    user_url: g.userUrl || '',
    status: g.status || 'draft',
    interview_status: g.interviewStatus || 'pending',
    system_score: Number(g.systemScore) || 0,
    docs_score: Number(g.docsScore) || 0,
    interview_score: Number(g.interviewScore) || 0,
    bonus_score: Number(g.bonusScore) || 0,
    student_feedback: g.studentFeedback || '',
    private_note: g.privateNote || '',
    checklist_json: JSON.stringify(g.checklist || { readme: false, teamSplit: false, individualReport: false, screenshots: false }),
    services_json: JSON.stringify(g.services || {
      frontend: { ok: false, statusCode: 0, label: 'N/A' },
      auth: { ok: false, statusCode: 0, label: 'N/A' },
      task: { ok: false, statusCode: 0, label: 'N/A' },
      user: { ok: false, statusCode: 0, label: 'N/A' }
    }),
    last_checked_at: g.lastCheckedAt || '',
    updated_at: g.updatedAt || new Date().toISOString()
  };
}

function allGroups() {
  return stmt.all.all().map(hydrateRow);
}

function findGroup(id) {
  return hydrateRow(stmt.byId.get(id));
}

function saveGroup(group) {
  stmt.upsert.run(rowParams(group));
  return findGroup(group.id);
}

function replaceGroups(items) {
  db.exec('BEGIN');
  try {
    stmt.clear.run();
    for (const item of items) stmt.upsert.run(rowParams(item));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function migrateLegacyJsonIfNeeded() {
  const count = stmt.count.get().c;
  if (count > 0) return;
  if (!fs.existsSync(LEGACY_JSON_FILE)) return;
  try {
    const items = JSON.parse(fs.readFileSync(LEGACY_JSON_FILE, 'utf8'));
    if (Array.isArray(items) && items.length) {
      replaceGroups(items);
      console.log(`Migrated ${items.length} groups from groups.json to SQLite`);
    }
  } catch (err) {
    console.error('Legacy JSON migration failed:', err.message);
  }
}

migrateLegacyJsonIfNeeded();

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extraHeaders });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function countDocs(group) {
  const checklist = group.checklist || {};
  return ['readme', 'teamSplit', 'individualReport', 'screenshots'].filter(k => checklist[k]).length;
}

function countLinks(group) {
  return ['repoUrl', 'readmeUrl', 'frontendUrl', 'authUrl', 'taskUrl', 'userUrl'].filter(k => !!group[k]).length;
}

function countServicesOk(group) {
  const services = group.services || {};
  return ['frontend', 'auth', 'task', 'user'].filter(k => services[k]?.ok).length;
}

function scoreTotal(group) {
  return (Number(group.systemScore) || 0) + (Number(group.docsScore) || 0) + (Number(group.interviewScore) || 0);
}

function isRecentCheck(lastCheckedAt) {
  if (!lastCheckedAt) return false;
  return (Date.now() - new Date(lastCheckedAt).getTime()) <= 15 * 60 * 1000;
}

function readiness(group) {
  const docsCount = countDocs(group);
  const urlsCount = countLinks(group);
  const serviceOk = countServicesOk(group);
  const scorePct = Math.min(100, scoreTotal(group));
  const interviewDone = group.interviewStatus === 'completed' ? 1 : 0;
  const recent = isRecentCheck(group.lastCheckedAt) ? 1 : 0;

  const total = Math.round(
    (docsCount / 4) * 15 +
    (urlsCount / 6) * 15 +
    (serviceOk / 4) * 35 +
    (scorePct / 100) * 25 +
    interviewDone * 5 +
    recent * 5
  );
  return Math.max(0, Math.min(100, total));
}

async function checkUrl(url, kind) {
  if (!url) return { ok: false, statusCode: 0, label: 'MISSING' };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, statusCode: 0, label: 'BAD_URL' };
  }

  const host = (parsed.hostname || '').toLowerCase();
  const pathname = parsed.pathname || '/';
  const isRepoHost = /(^|\.)github\.com$|(^|\.)gitlab\.com$|(^|\.)bitbucket\.org$/i.test(host);

  if (kind === 'frontend' && isRepoHost) {
    return { ok: false, statusCode: 0, label: 'REPO_URL' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  const start = Date.now();

  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
    const ms = Date.now() - start;
    clearTimeout(timeout);

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const headerMarker = res.headers.get(FRONTEND_HEALTH_HEADER);

    if (!res.ok) {
      return { ok: false, statusCode: res.status, label: `HTTP ${res.status}` };
    }

    if (kind === 'frontend') {
      const text = await res.text();
      const bodyHasMarker = text.includes(`name="engse207-frontend"`) && text.includes(`content="${FRONTEND_HEALTH_MARKER}"`);
      const headerOk = headerMarker === FRONTEND_HEALTH_MARKER;
      const htmlish = contentType.includes('text/html') || text.trim().startsWith('<!DOCTYPE html') || text.trim().startsWith('<html');
      const ok = htmlish && (headerOk || bodyHasMarker);
      return {
        ok,
        statusCode: res.status,
        label: ok ? `OK ${ms}ms` : (htmlish ? 'NO_MARKER' : 'NOT_HTML')
      };
    }

    const json = await res.json().catch(() => null);
    if (!json || typeof json !== 'object') {
      return { ok: false, statusCode: res.status, label: 'NOT_JSON' };
    }

    const expectedService =
      kind === 'auth' ? 'auth-service' :
      kind === 'task' ? 'task-service' :
      kind === 'user' ? 'user-service' : '';

    const ok = json.status === 'ok' && (!expectedService || json.service === expectedService);
    return {
      ok,
      statusCode: res.status,
      label: ok ? `OK ${ms}ms` : (json.status !== 'ok' ? 'BAD_STATUS' : `BAD_SERVICE:${json.service || '-'}`)
    };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, statusCode: 0, label: err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR' };
  }
}

async function refreshGroup(group) {
  const frontend = await checkUrl(group.frontendUrl, 'frontend');
  const auth = await checkUrl(group.authUrl, 'auth');
  const task = await checkUrl(group.taskUrl, 'task');
  const user = await checkUrl(group.userUrl, 'user');
  group.services = { frontend, auth, task, user };
  const okCount = [frontend, auth, task, user].filter(s => s.ok).length;
  const configuredCount = [group.frontendUrl, group.authUrl, group.taskUrl, group.userUrl].filter(Boolean).length;

  if (configuredCount === 0) group.status = 'draft';
  else if (okCount === 4) group.status = 'ready';
  else if (okCount >= 2) group.status = 'partial';
  else if (okCount === 0) group.status = 'failed';
  else group.status = 'partial';

  group.lastCheckedAt = new Date().toISOString();
  group.updatedAt = new Date().toISOString();
  return group;
}

function withComputed(group) {
  return {
    ...group,
    totalScore: scoreTotal(group),
    readiness: readiness(group),
    docsCount: countDocs(group),
    linksCount: countLinks(group),
    servicesOk: countServicesOk(group)
  };
}

function buildSummary(groups) {
  return {
    checked: groups.filter(g => !!g.lastCheckedAt).length,
    ready: groups.filter(g => g.status === 'ready').length,
    partial: groups.filter(g => g.status === 'partial').length,
    failed: groups.filter(g => g.status === 'failed').length,
    draft: groups.filter(g => g.status === 'draft').length
  };
}

function metaPayload(groupsComputed) {
  return {
    checker: {
      enabled: runtime.checkerEnabled,
      running: runtime.checkerRunning,
      intervalMs: AUTO_CHECK_MS,
      lastRunAt: runtime.checkerLastRunAt,
      summary: runtime.checkerLastSummary,
      clients: sseClients.size
    },
    storage: {
      mode: 'sqlite',
      file: DB_FILE
    },
    totals: {
      groups: groupsComputed.length,
      avgReadiness: groupsComputed.length ? Math.round(groupsComputed.reduce((s, g) => s + (g.readiness || 0), 0) / groupsComputed.length) : 0,
      avgScore: groupsComputed.length ? Math.round(groupsComputed.reduce((s, g) => s + (g.totalScore || 0), 0) / groupsComputed.length) : 0
    }
  };
}

function snapshotPayload(reason = 'refresh') {
  const groupsComputed = allGroups().map(withComputed);
  return {
    reason,
    at: new Date().toISOString(),
    items: groupsComputed,
    meta: metaPayload(groupsComputed)
  };
}

function sendSSE(client, event, data) {
  client.write(`event: ${event}\n`);
  client.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastSnapshot(reason = 'refresh') {
  if (!sseClients.size) return;
  const payload = snapshotPayload(reason);
  for (const client of sseClients) sendSSE(client, 'snapshot', payload);
}

function broadcastMeta(reason = 'meta') {
  if (!sseClients.size) return;
  const payload = { reason, at: new Date().toISOString(), meta: metaPayload(allGroups().map(withComputed)) };
  for (const client of sseClients) sendSSE(client, 'meta', payload);
}

async function runBackgroundCheck() {
  if (runtime.checkerRunning || !runtime.checkerEnabled) return;
  runtime.checkerRunning = true;
  broadcastMeta('checker-start');
  try {
    const groups = allGroups();
    let changed = false;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const hasAnyServiceUrl = !!(g.frontendUrl || g.authUrl || g.taskUrl || g.userUrl);
      if (!hasAnyServiceUrl) continue;
      groups[i] = await refreshGroup(g);
      saveGroup(groups[i]);
      changed = true;
    }
    const latest = allGroups();
    runtime.checkerLastRunAt = new Date().toISOString();
    runtime.checkerLastSummary = buildSummary(latest);
    if (changed) broadcastSnapshot('background-check');
    else broadcastMeta('background-check-nochange');
  } catch (err) {
    console.error('Background checker failed:', err.message);
  } finally {
    runtime.checkerRunning = false;
    broadcastMeta('checker-stop');
  }
}

function matchApi(pathname, pattern) {
  const a = pathname.split('/').filter(Boolean);
  const b = pattern.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (b[i].startsWith(':')) params[b[i].slice(1)] = a[i];
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath);
    const typeMap = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };
    const extra = (safePath === '/index.html')
      ? { [FRONTEND_HEALTH_HEADER]: FRONTEND_HEALTH_MARKER }
      : {};
    sendText(res, 200, data, typeMap[ext] || 'application/octet-stream', extra);
  });
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function groupsToCsv(groupsComputed) {
  const headers = [
    'groupName','members','status','interviewStatus','systemScore','docsScore','interviewScore','bonusScore','totalScore','readiness',
    'docsCount','linksCount','servicesOk','repoUrl','readmeUrl','frontendUrl','authUrl','taskUrl','userUrl','lastCheckedAt','updatedAt'
  ];
  const lines = [headers.join(',')];
  for (const g of groupsComputed) {
    const row = [
      g.groupName,
      (g.members || []).join(' | '),
      g.status,
      g.interviewStatus,
      g.systemScore,
      g.docsScore,
      g.interviewScore,
      g.bonusScore,
      g.totalScore,
      g.readiness,
      g.docsCount,
      g.linksCount,
      g.servicesOk,
      g.repoUrl,
      g.readmeUrl,
      g.frontendUrl,
      g.authUrl,
      g.taskUrl,
      g.userUrl,
      g.lastCheckedAt,
      g.updatedAt
    ].map(csvEscape);
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;

  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    sendSSE(res, 'snapshot', snapshotPayload('initial-stream'));
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      } catch {}
    }, 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }


  if (req.method === 'GET' && pathname === MOCK_HEALTH_PATH) {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'mock-health',
      source: `http://${req.headers.host}`,
      marker: 'engse207-monitor-mock'
    });
  }

  if (req.method === 'GET' && pathname === MOCK_FRONTEND_PATH) {
    return sendText(
      res,
      200,
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="engse207-frontend" content="${FRONTEND_HEALTH_MARKER}"><title>Mock Frontend</title></head><body><h1>Mock Frontend OK</h1></body></html>`,
      'text/html; charset=utf-8',
      { [FRONTEND_HEALTH_HEADER]: FRONTEND_HEALTH_MARKER }
    );
  }

  if (req.method === 'GET' && pathname === MOCK_AUTH_HEALTH_PATH) {
    return sendJson(res, 200, { status: 'ok', service: 'auth-service', source: `http://${req.headers.host}` });
  }

  if (req.method === 'GET' && pathname === MOCK_TASK_HEALTH_PATH) {
    return sendJson(res, 200, { status: 'ok', service: 'task-service', source: `http://${req.headers.host}` });
  }

  if (req.method === 'GET' && pathname === MOCK_USER_HEALTH_PATH) {
    return sendJson(res, 200, { status: 'ok', service: 'user-service', source: `http://${req.headers.host}` });
  }

  if (pathname.startsWith('/api/')) {
    try {
      if (req.method === 'GET' && pathname === '/api/groups') {
        const groups = allGroups().map(withComputed);
        return sendJson(res, 200, { items: groups });
      }

      if (req.method === 'GET' && pathname === '/api/meta') {
        const groups = allGroups().map(withComputed);
        return sendJson(res, 200, metaPayload(groups));
      }

      if (req.method === 'POST' && pathname === '/api/meta/checker') {
        const body = await readBody(req);
        if (typeof body.enabled === 'boolean') runtime.checkerEnabled = body.enabled;
        broadcastMeta('checker-toggle');
        return sendJson(res, 200, {
          enabled: runtime.checkerEnabled,
          running: runtime.checkerRunning,
          intervalMs: AUTO_CHECK_MS,
          lastRunAt: runtime.checkerLastRunAt
        });
      }

      if (req.method === 'POST' && pathname === '/api/groups') {
        const body = await readBody(req);
        const item = normalizeGroup({
          ...body,
          id: body.id || `g-${Math.random().toString(36).slice(2, 9)}`,
          updatedAt: new Date().toISOString()
        });
        saveGroup(item);
        broadcastSnapshot('group-created');
        return sendJson(res, 201, { item: withComputed(findGroup(item.id)) });
      }

      let params = matchApi(pathname, '/api/groups/:id');
      if (params && req.method === 'GET') {
        const item = findGroup(params.id);
        if (!item) return sendJson(res, 404, { error: 'Group not found' });
        return sendJson(res, 200, { item: withComputed(item) });
      }
      if (params && req.method === 'PUT') {
        const body = await readBody(req);
        const current = findGroup(params.id);
        if (!current) return sendJson(res, 404, { error: 'Group not found' });
        const merged = normalizeGroup({ ...current, ...body, id: params.id, updatedAt: new Date().toISOString() });
        saveGroup(merged);
        broadcastSnapshot('group-updated');
        return sendJson(res, 200, { item: withComputed(findGroup(params.id)) });
      }
      if (params && req.method === 'DELETE') {
        stmt.deleteById.run(params.id);
        broadcastSnapshot('group-deleted');
        return sendJson(res, 200, { ok: true });
      }

      params = matchApi(pathname, '/api/groups/:id/check-health');
      if (params && req.method === 'POST') {
        const current = findGroup(params.id);
        if (!current) return sendJson(res, 404, { error: 'Group not found' });
        const refreshed = await refreshGroup(current);
        saveGroup(refreshed);
        const latest = allGroups();
        runtime.checkerLastRunAt = new Date().toISOString();
        runtime.checkerLastSummary = buildSummary(latest);
        broadcastSnapshot('single-health-check');
        return sendJson(res, 200, { item: withComputed(findGroup(params.id)) });
      }

      if (pathname === '/api/check-all' && req.method === 'POST') {
        const groups = allGroups();
        for (let i = 0; i < groups.length; i++) saveGroup(await refreshGroup(groups[i]));
        const latest = allGroups();
        runtime.checkerLastRunAt = new Date().toISOString();
        runtime.checkerLastSummary = buildSummary(latest);
        broadcastSnapshot('check-all');
        return sendJson(res, 200, { items: latest.map(withComputed) });
      }

      if (pathname === '/api/export' && req.method === 'GET') {
        const groups = allGroups();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="set2-groups-export.json"'
        });
        res.end(JSON.stringify(groups, null, 2));
        return;
      }

      if (pathname === '/api/export.csv' && req.method === 'GET') {
        const csv = groupsToCsv(allGroups().map(withComputed));
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="set2-groups-export.csv"'
        });
        res.end(csv);
        return;
      }

      if (pathname === '/api/import' && req.method === 'POST') {
        const body = await readBody(req);
        if (!Array.isArray(body.items)) return sendJson(res, 400, { error: 'items array required' });
        replaceGroups(body.items.map(item => normalizeGroup(item)));
        broadcastSnapshot('import');
        return sendJson(res, 200, { ok: true, count: body.items.length });
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || 'Server error' });
    }
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Set 2 dashboard prototype running at http://localhost:${PORT}`);
  console.log(`SQLite storage: ${DB_FILE}`);
  setTimeout(() => { runBackgroundCheck(); }, 1000);
  setInterval(runBackgroundCheck, AUTO_CHECK_MS);
});
