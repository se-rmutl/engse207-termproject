import React, { useEffect, useMemo, useRef, useState } from 'https://esm.sh/react@18';
import { createRoot } from 'https://esm.sh/react-dom@18/client';

const API = '';
const FALLBACK_POLL_MS = 30000;

const emptyGroup = () => ({
  id: undefined,
  groupName: 'New Group',
  membersText: '',
  repoUrl: '',
  readmeUrl: '',
  frontendUrl: '',
  authUrl: '',
  taskUrl: '',
  userUrl: '',
  status: 'draft',
  interviewStatus: 'pending',
  systemScore: 0,
  docsScore: 0,
  interviewScore: 0,
  bonusScore: 0,
  studentFeedback: '',
  privateNote: '',
  checklist: { readme: false, teamSplit: false, individualReport: false, screenshots: false },
  services: {
    frontend: { ok: false, statusCode: 0, label: 'N/A' },
    auth: { ok: false, statusCode: 0, label: 'N/A' },
    task: { ok: false, statusCode: 0, label: 'N/A' },
    user: { ok: false, statusCode: 0, label: 'N/A' }
  },
  studentVisible: true,
  lastCheckedAt: '',
  updatedAt: ''
});

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
    let err = 'Request failed';
    try {
      const data = await res.json();
      err = data.error || err;
    } catch {}
    throw new Error(err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function statusClass(status) {
  return { ready: 'ready', partial: 'partial', failed: 'failed', draft: 'draft' }[status] || 'draft';
}
function symClass(service) {
  if (!service) return 'off';
  if (service.ok) return 'ok';
  if (service.statusCode) return 'bad';
  return 'off';
}
function fmtDate(s) { return s ? new Date(s).toLocaleString('th-TH') : '-'; }
function isStale(s) { return !s || (Date.now() - new Date(s).getTime()) > 15 * 60 * 1000; }

function App() {
  const [groups, setGroups] = useState([]);
  const [meta, setMeta] = useState({ checker: { enabled: true, running: false, intervalMs: 60000, lastRunAt: '', clients: 0 }, totals: { groups: 0, avgReadiness: 0, avgScore: 0 } });
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [interviewFilter, setInterviewFilter] = useState('all');
  const [docsFilter, setDocsFilter] = useState('all');
  const [healthFilter, setHealthFilter] = useState('all');
  const [sortBy, setSortBy] = useState('ready');
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [message, setMessage] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [streamState, setStreamState] = useState({ mode: 'connecting', lastEventAt: '', fallback: false });
  const streamRef = useRef(null);

  async function loadAll(selectId) {
    const [groupsData, metaData] = await Promise.all([api('/api/groups'), api('/api/meta')]);
    const items = groupsData.items || [];
    setGroups(items);
    setMeta(metaData || meta);

    if (isEditing && selectId === undefined) return;

    let nextId;
    if (selectId !== undefined) nextId = selectId;
    else if (selectedId !== null) nextId = selectedId;
    else nextId = items[0]?.id || null;
    setSelectedId(nextId);
  }

  function applySnapshot(payload) {
    if (!payload) return;
    if (Array.isArray(payload.items)) setGroups(payload.items);
    if (payload.meta) setMeta(payload.meta);
    setStreamState(prev => ({ ...prev, mode: 'open', lastEventAt: payload.at || new Date().toISOString(), fallback: false }));
  }

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    streamRef.current = es;
    setStreamState(prev => ({ ...prev, mode: 'connecting' }));

    const onSnapshot = e => {
      try {
        applySnapshot(JSON.parse(e.data));
      } catch {}
    };
    const onMeta = e => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.meta) setMeta(payload.meta);
        setStreamState(prev => ({ ...prev, mode: 'open', lastEventAt: payload.at || new Date().toISOString(), fallback: false }));
      } catch {}
    };
    const onPing = e => {
      try {
        const payload = JSON.parse(e.data);
        setStreamState(prev => ({ ...prev, mode: 'open', lastEventAt: payload.at || new Date().toISOString(), fallback: false }));
      } catch {}
    };

    es.addEventListener('snapshot', onSnapshot);
    es.addEventListener('meta', onMeta);
    es.addEventListener('ping', onPing);
    es.onopen = () => setStreamState(prev => ({ ...prev, mode: 'open', fallback: false }));
    es.onerror = () => setStreamState(prev => ({ ...prev, mode: 'disconnected', fallback: true }));

    return () => {
      es.close();
    };
  }, []);

  useEffect(() => {
    if (!streamState.fallback) return;
    const timer = setInterval(() => {
      if (!isEditing) loadAll();
    }, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [streamState.fallback, isEditing, selectedId]);

  useEffect(() => {
    const selected = groups.find(g => g.id === selectedId);
    if (!selected) {
      if (!isEditing) setDetail(null);
      return;
    }
    if (isEditing && detail?.id === selected.id) return;
    setDetail({ ...selected, membersText: Array.isArray(selected.members) ? selected.members.join(', ') : '' });
  }, [groups, selectedId, isEditing]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let items = groups.filter(g => {
      const hay = [g.groupName, (g.members || []).join(' '), g.repoUrl, g.privateNote, g.studentFeedback].join(' ').toLowerCase();
      if (q && !hay.includes(q)) return false;
      if (statusFilter !== 'all' && g.status !== statusFilter) return false;
      if (interviewFilter !== 'all' && g.interviewStatus !== interviewFilter) return false;
      if (docsFilter === 'complete' && (g.docsCount || 0) < 4) return false;
      if (docsFilter === 'missing' && (g.docsCount || 0) >= 4) return false;
      if (healthFilter === 'healthy' && (g.servicesOk || 0) < 4) return false;
      if (healthFilter === 'issues' && (g.servicesOk || 0) >= 4) return false;
      if (healthFilter === 'stale' && !isStale(g.lastCheckedAt)) return false;
      return true;
    });

    items = items.slice().sort((a, b) => {
      if (sortBy === 'score') return (b.totalScore || 0) - (a.totalScore || 0);
      if (sortBy === 'ready') return (b.readiness || 0) - (a.readiness || 0);
      if (sortBy === 'updated') return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
      if (sortBy === 'checked') return new Date(b.lastCheckedAt || 0) - new Date(a.lastCheckedAt || 0);
      return a.groupName.localeCompare(b.groupName, 'th');
    });
    return items;
  }, [groups, search, statusFilter, interviewFilter, docsFilter, healthFilter, sortBy]);

  const summary = useMemo(() => {
    const ready = groups.filter(g => g.status === 'ready').length;
    const partial = groups.filter(g => g.status === 'partial').length;
    const failed = groups.filter(g => g.status === 'failed').length;
    const completed = groups.filter(g => g.interviewStatus === 'completed').length;
    const stale = groups.filter(g => isStale(g.lastCheckedAt)).length;
    const avgScore = groups.length ? Math.round(groups.reduce((s, g) => s + (g.totalScore || 0), 0) / groups.length) : 0;
    const avgReady = groups.length ? Math.round(groups.reduce((s, g) => s + (g.readiness || 0), 0) / groups.length) : 0;
    return { total: groups.length, ready, partial, failed, completed, stale, avgScore, avgReady };
  }, [groups]);

  function updateDetail(key, value) {
    setIsEditing(true);
    setDetail(prev => ({ ...prev, [key]: value }));
  }

  function updateChecklist(key, value) {
    setIsEditing(true);
    setDetail(prev => ({ ...prev, checklist: { ...prev.checklist, [key]: value } }));
  }

  async function saveGroup() {
    if (!detail) return;
    setLoading(true);
    try {
      const payload = {
        ...detail,
        members: detail.membersText.split(',').map(s => s.trim()).filter(Boolean)
      };
      delete payload.membersText;
      let savedId = payload.id;
      if (payload.id) {
        const res = await api(`/api/groups/${payload.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        savedId = res.item.id;
      } else {
        const res = await api('/api/groups', { method: 'POST', body: JSON.stringify(payload) });
        savedId = res.item.id;
      }
      setSelectedId(savedId);
      setIsEditing(false);
      await loadAll(savedId);
      setMessage('บันทึกข้อมูลแล้ว');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(''), 2500);
    }
  }

  async function removeGroup() {
    if (!detail?.id) return;
    if (!confirm(`ลบ ${detail.groupName} ?`)) return;
    setLoading(true);
    try {
      await api(`/api/groups/${detail.id}`, { method: 'DELETE' });
      setIsEditing(false);
      setSelectedId(null);
      await loadAll(null);
      setMessage('ลบกลุ่มแล้ว');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  function newGroup() {
    setIsEditing(true);
    setDetail(emptyGroup());
    setSelectedId(null);
  }

  function duplicateGroup() {
    if (!detail) return;
    setIsEditing(true);
    const clone = { ...detail, id: undefined, groupName: `${detail.groupName} Copy`, membersText: detail.membersText };
    setDetail(clone);
    setSelectedId(null);
  }

  function fillMockHealthUrls() {
    const origin = window.location.origin;
    setIsEditing(true);
    setDetail(prev => ({
      ...prev,
      frontendUrl: `${origin}/mock/frontend`,
      authUrl: `${origin}/mock/auth/health`,
      taskUrl: `${origin}/mock/tasks/health`,
      userUrl: `${origin}/mock/users/health`
    }));
    setMessage('ใส่ mock health URLs แล้ว');
    setTimeout(() => setMessage(''), 2500);
  }

  async function refreshOne() {
    if (!detail?.id) return;
    setLoading(true);
    try {
      await api(`/api/groups/${detail.id}/check-health`, { method: 'POST' });
      setIsEditing(false);
      await loadAll(detail.id);
      setMessage('เช็ก health แล้ว');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshAll() {
    setLoading(true);
    try {
      await api('/api/check-all', { method: 'POST' });
      if (!isEditing) await loadAll();
      setMessage('เช็กทุกกลุ่มแล้ว');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function toggleChecker() {
    setLoading(true);
    try {
      await api('/api/meta/checker', { method: 'POST', body: JSON.stringify({ enabled: !meta.checker?.enabled }) });
      await loadAll(selectedId ?? undefined);
      setMessage(meta.checker?.enabled ? 'ปิด background checker แล้ว' : 'เปิด background checker แล้ว');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(''), 2500);
    }
  }

  function exportJson() {
    window.open('/api/export', '_blank');
  }

  function exportCsv() {
    window.open('/api/export.csv', '_blank');
  }

  async function importJson(file) {
    const text = await file.text();
    const items = JSON.parse(text);
    setLoading(true);
    try {
      await api('/api/import', { method: 'POST', body: JSON.stringify({ items }) });
      await loadAll();
      setMessage('นำเข้าข้อมูลแล้ว');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  function printSummary() {
    const rows = filtered.map(g => `
      <tr>
        <td>${escapeHtml(g.groupName)}</td>
        <td>${escapeHtml((g.members || []).join(', '))}</td>
        <td>${escapeHtml(g.status || '-')}</td>
        <td>${g.totalScore || 0}/100</td>
        <td>+${g.bonusScore || 0}</td>
        <td>${g.readiness || 0}%</td>
        <td>${g.servicesOk || 0}/4</td>
        <td>${g.docsCount || 0}/4</td>
        <td>${escapeHtml(fmtDate(g.lastCheckedAt))}</td>
      </tr>`).join('');
    const win = window.open('', '_blank', 'width=1200,height=800');
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Set 2 Summary</title>
      <style>
        body{font-family:Arial,sans-serif;padding:24px;color:#163047} h1{margin:0 0 8px} p{margin:0 0 18px;color:#556}
        table{border-collapse:collapse;width:100%;font-size:13px} th,td{border:1px solid #cfd8e3;padding:8px;text-align:left;vertical-align:top}
        th{background:#eef4ff} .meta{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}.chip{padding:6px 10px;border:1px solid #cfd8e3;border-radius:999px;background:#f8fbff}
      </style></head><body>
      <h1>ENGSE207 Set 2 Monitoring Summary</h1>
      <p>พิมพ์เมื่อ ${escapeHtml(fmtDate(new Date().toISOString()))}</p>
      <div class="meta">
        <span class="chip">Groups: ${summary.total}</span>
        <span class="chip">Ready: ${summary.ready}</span>
        <span class="chip">Issues: ${summary.partial + summary.failed}</span>
        <span class="chip">Avg Ready: ${summary.avgReady}%</span>
        <span class="chip">Realtime: ${streamLabel(streamState)}</span>
      </div>
      <table><thead><tr><th>Group</th><th>Members</th><th>Status</th><th>Score</th><th>Bonus</th><th>Ready</th><th>Svc</th><th>Docs</th><th>Last checked</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9">No groups</td></tr>'}</tbody></table>
      </body></html>`);
    win.document.close();
    win.focus();
    win.print();
  }

  return React.createElement('div', { className: `app${loading ? ' loading' : ''}` },
    React.createElement('div', { className: 'left' },
      React.createElement('section', { className: 'panel' },
        React.createElement('div', { className: 'panel-head' },
          React.createElement('div', null,
            React.createElement('h1', null, 'ENGSE207 Set 2 Monitoring Dashboard'),
            React.createElement('div', { className: 'sub' }, `React + Node.js Prototype — realtime ด้วย SSE${isEditing ? ' (pause sync ระหว่างแก้ฟอร์ม)' : ''}`)
          ),
          React.createElement('div', { className: 'pill' }, 'Phase 3')
        ),
        React.createElement('div', { className: 'panel-body' },
          React.createElement('div', { className: 'summary' },
            metric('Groups', summary.total),
            metric('Ready', summary.ready),
            metric('Issues', summary.partial + summary.failed),
            metric('Interviewed', summary.completed),
            metric('Avg Ready', `${summary.avgReady}%`)
          ),
          React.createElement('div', { className: 'meta-strip' },
            metaChip(meta.checker?.enabled ? 'Auto-check ON' : 'Auto-check OFF', meta.checker?.enabled ? 'good' : 'warn'),
            metaChip(`SSE ${streamLabel(streamState)}`, streamState.mode === 'open' ? 'good' : (streamState.mode === 'connecting' ? 'neutral' : 'warn')),
            metaChip(`Clients ${meta.checker?.clients || 0}`, 'neutral'),
            metaChip(`รอบ health ${Math.round((meta.checker?.intervalMs || 60000) / 1000)} วิ`, 'neutral'),
            metaChip(`last event ${fmtDate(streamState.lastEventAt)}`, isStale(streamState.lastEventAt) ? 'warn' : 'neutral'),
            metaChip(`Stale ${summary.stale}`, summary.stale ? 'warn' : 'neutral')
          )
        )
      ),
      React.createElement('section', { className: 'panel' },
        React.createElement('div', { className: 'panel-head' },
          React.createElement('h2', null, 'กลุ่มและสถานะระบบ'),
          React.createElement('div', { className: 'footer-actions' },
            React.createElement('button', { className: 'soft', onClick: refreshAll }, 'เช็กทุกกลุ่ม'),
            React.createElement('button', { className: 'soft', onClick: toggleChecker }, meta.checker?.enabled ? 'ปิด auto-check' : 'เปิด auto-check'),
            React.createElement('button', { className: 'soft', onClick: exportJson }, 'Export JSON'),
            React.createElement('button', { className: 'soft', onClick: exportCsv }, 'Export CSV'),
            React.createElement('button', { className: 'soft', onClick: printSummary }, 'พิมพ์สรุป'),
            React.createElement('label', { className: 'soft file-like', style: { display: 'inline-flex', alignItems: 'center', cursor: 'pointer' } },
              'Import JSON',
              React.createElement('input', { type: 'file', hidden: true, accept: 'application/json', onChange: e => e.target.files[0] && importJson(e.target.files[0]) })
            )
          )
        ),
        React.createElement('div', { className: 'panel-body' },
          React.createElement('div', { className: 'toolbar phase2' },
            React.createElement('input', { value: search, onChange: e => setSearch(e.target.value), placeholder: 'ค้นหากลุ่ม / สมาชิก / repo / note' }),
            select(statusFilter, setStatusFilter, [['all', 'ทุกสถานะ'], ['ready', 'Ready'], ['partial', 'Partial'], ['failed', 'Failed'], ['draft', 'Draft']]),
            select(interviewFilter, setInterviewFilter, [['all', 'สัมภาษณ์ทั้งหมด'], ['pending', 'Pending'], ['completed', 'Completed']]),
            select(docsFilter, setDocsFilter, [['all', 'เอกสารทั้งหมด'], ['complete', 'เอกสารครบ'], ['missing', 'เอกสารยังขาด']]),
            select(healthFilter, setHealthFilter, [['all', 'health ทั้งหมด'], ['healthy', 'service ผ่านครบ'], ['issues', 'มี service มีปัญหา'], ['stale', 'ผลตรวจเก่า']]),
            select(sortBy, setSortBy, [['ready', 'เรียงตาม readiness'], ['score', 'เรียงตามคะแนน'], ['checked', 'เรียงตามตรวจล่าสุด'], ['updated', 'อัปเดตล่าสุด'], ['name', 'เรียงตามชื่อ']]),
            React.createElement('button', { className: 'primary', onClick: newGroup }, '+ เพิ่มกลุ่ม')
          ),
          React.createElement('div', { style: { height: '14px' } }),
          React.createElement('div', { className: 'cards' },
            filtered.map(group => React.createElement(GroupCard, {
              key: group.id,
              group,
              active: selectedId === group.id,
              onClick: () => { setIsEditing(false); setSelectedId(group.id); }
            }))
          )
        )
      )
    ),
    React.createElement('div', { className: 'right' },
      React.createElement('section', { className: 'panel' },
        React.createElement('div', { className: 'panel-head' },
          React.createElement('div', null,
            React.createElement('h2', null, detail?.groupName || 'เลือกกลุ่มเพื่อดูรายละเอียด'),
            React.createElement('div', { className: 'sub' }, detail ? `อัปเดตล่าสุด: ${fmtDate(detail.updatedAt)} · ตรวจ health: ${fmtDate(detail.lastCheckedAt)}` : 'รายละเอียดแบบเต็ม, คะแนน, links และ feedback')
          ),
          React.createElement('div', { className: 'footer-actions' },
            React.createElement('button', { className: 'soft', onClick: duplicateGroup, disabled: !detail, title: 'สร้างกลุ่มใหม่โดยคัดลอกข้อมูลจากกลุ่มที่เลือก' }, 'คัดลอก'),
            React.createElement('button', { className: 'soft', onClick: refreshOne, disabled: !detail?.id, title: 'ตรวจ URLs และอัปเดตสถานะ health ของกลุ่มที่เลือก' }, 'เช็ก health'),
            React.createElement('button', { className: 'primary', onClick: saveGroup, disabled: !detail, title: 'บันทึกข้อมูลที่แก้ไขในแผงรายละเอียด' }, 'บันทึก'),
            React.createElement('button', { className: 'danger', onClick: removeGroup, disabled: !detail?.id }, 'ลบ')
          )
        ),
        React.createElement('div', { className: 'panel-body' },
          message && React.createElement('div', { className: 'note', style: { marginBottom: '12px' } }, message),
          !detail ? React.createElement('div', { className: 'muted-box' }, 'เลือกกลุ่มทางซ้าย หรือกด “เพิ่มกลุ่ม” เพื่อเริ่มกรอกข้อมูล') : React.createElement(DetailPanel, { detail, updateDetail, updateChecklist, fillMockHealthUrls })
        )
      )
    )
  );
}

function metric(k, v) {
  return React.createElement('div', { className: 'metric' }, React.createElement('div', { className: 'k' }, k), React.createElement('div', { className: 'v' }, v));
}

function metaChip(label, tone) {
  return React.createElement('span', { className: `meta-chip ${tone || 'neutral'}` }, label);
}

function select(value, onChange, options) {
  return React.createElement('select', { value, onChange: e => onChange(e.target.value) }, options.map(([v, label]) => React.createElement('option', { key: v, value: v }, label)));
}

function GroupCard({ group, active, onClick }) {
  const stale = isStale(group.lastCheckedAt);
  return React.createElement('div', { className: `card ${active ? 'active' : ''}`, onClick },
    React.createElement('div', { className: 'ultra-top' },
      React.createElement('div', { className: 'title-wrap' },
        React.createElement('div', { className: 'group-title' }, group.groupName),
        React.createElement('div', { className: 'group-meta' }, (group.members || []).join(', '))
      ),
      React.createElement('div', { className: 'score-stack' },
        React.createElement('div', { className: 'badge ' + statusClass(group.status) }, group.status.toUpperCase()),
        React.createElement('div', { className: 'score-main' }, `${group.totalScore || 0}`, React.createElement('small', null, '/100'))
      )
    ),
    React.createElement('div', { className: 'statline' },
      React.createElement('div', { className: 'stats-inline' },
        React.createElement('span', { className: 'st' }, React.createElement('b', null, 'S'), ': ', group.servicesOk || 0, '/4'),
        React.createElement('span', { className: 'st' }, React.createElement('b', null, 'D'), ': ', group.docsCount || 0, '/4'),
        React.createElement('span', { className: 'st' }, React.createElement('b', null, 'U'), ': ', group.linksCount || 0, '/6'),
        React.createElement('span', { className: 'st' }, React.createElement('b', null, 'R'), ': ', group.readiness || 0, '%')
      )
    ),
    React.createElement('div', { className: 'row' },
      React.createElement('div', { className: 'symbols' },
        symbol('F', group.services?.frontend),
        symbol('A', group.services?.auth),
        symbol('T', group.services?.task),
        symbol('U', group.services?.user)
      ),
      React.createElement('div', { className: 'tiny', title: `System ${group.systemScore || 0}/90 · Docs ${group.docsScore || 0}/5 · Interview ${group.interviewScore || 0}/5` }, `${group.systemScore || 0}/90 · ${group.docsScore || 0}/5 · ${group.interviewScore || 0}/5`)
    ),
    React.createElement('div', { className: 'bottomline' },
      React.createElement('div', { className: 'small' }, group.studentFeedback || group.privateNote || 'ยังไม่มี feedback'),
      React.createElement('span', { className: `chip-mini ${stale ? 'warn' : ''}` }, stale ? 'H!' : (group.interviewStatus === 'completed' ? 'I✓' : 'I…')),
      React.createElement('span', { className: 'bonus' }, `+${group.bonusScore || 0}`)
    )
  );
}

function symbol(label, service) {
  return React.createElement('span', { className: `sym ${symClass(service)}` }, label);
}

function DetailPanel({ detail, updateDetail, updateChecklist, fillMockHealthUrls }) {
  return React.createElement('div', { className: 'section' },
    React.createElement('div', { className: 'detail-grid' },
      React.createElement('div', { className: 'section' },
        React.createElement('h3', null, 'ข้อมูลกลุ่ม'),
        React.createElement('div', { className: 'fields' },
          field('ชื่อกลุ่ม', React.createElement('input', { value: detail.groupName, onChange: e => updateDetail('groupName', e.target.value) })),
          field('รหัสนักศึกษา', React.createElement('input', { value: detail.membersText, onChange: e => updateDetail('membersText', e.target.value), placeholder: '650000001, 650000002' })),
          field('สถานะกลุ่ม', select(detail.status, v => updateDetail('status', v), [['draft','Draft'],['partial','Partial'],['ready','Ready'],['failed','Failed']])),
          field('สถานะสัมภาษณ์', select(detail.interviewStatus, v => updateDetail('interviewStatus', v), [['pending','Pending'],['completed','Completed']]))
        ),
        React.createElement('div', { className: 'note compact-note' }, `Readiness: ${detail.readiness || 0}% · Docs: ${detail.docsCount || 0}/4 · URLs: ${detail.linksCount || 0}/6 · Services: ${detail.servicesOk || 0}/4`),
        React.createElement('h3', null, 'URLs'),
        React.createElement('div', { className: 'fields' },
          field('Repo URL', React.createElement('input', { value: detail.repoUrl, onChange: e => updateDetail('repoUrl', e.target.value) })),
          field('README URL', React.createElement('input', { value: detail.readmeUrl, onChange: e => updateDetail('readmeUrl', e.target.value) })),
          field('Frontend URL', React.createElement('input', { value: detail.frontendUrl, onChange: e => updateDetail('frontendUrl', e.target.value) })),
          field('Auth health URL', React.createElement('input', { value: detail.authUrl, onChange: e => updateDetail('authUrl', e.target.value) })),
          field('Task health URL', React.createElement('input', { value: detail.taskUrl, onChange: e => updateDetail('taskUrl', e.target.value) })),
          field('User health URL', React.createElement('input', { value: detail.userUrl, onChange: e => updateDetail('userUrl', e.target.value) }))
        ),
        React.createElement('div', { className: 'footer-actions' },
          React.createElement('button', { className: 'soft', type: 'button', onClick: fillMockHealthUrls }, 'ใส่ mock health ทั้ง 4 ช่อง')
        ),
        React.createElement('div', { className: 'note compact-note' }, `mock demo: ${window.location.origin}/mock/frontend | /mock/auth/health | /mock/tasks/health | /mock/users/health`)
      ),
      React.createElement('div', { className: 'section' },
        React.createElement('h3', null, 'คะแนน'),
        React.createElement('div', { className: 'score-grid' },
          field('ระบบ/90', React.createElement('input', { type: 'number', min: 0, max: 90, value: detail.systemScore, onChange: e => updateDetail('systemScore', Number(e.target.value)) })),
          field('เอกสาร/5', React.createElement('input', { type: 'number', min: 0, max: 5, value: detail.docsScore, onChange: e => updateDetail('docsScore', Number(e.target.value)) })),
          field('สัมภาษณ์/5', React.createElement('input', { type: 'number', min: 0, max: 5, value: detail.interviewScore, onChange: e => updateDetail('interviewScore', Number(e.target.value)) })),
          field('โบนัส', React.createElement('input', { type: 'number', min: 0, value: detail.bonusScore, onChange: e => updateDetail('bonusScore', Number(e.target.value)) }))
        ),
        React.createElement('div', { className: 'note' }, `คะแนนหลักรวม: ${(detail.systemScore||0)+(detail.docsScore||0)+(detail.interviewScore||0)} /100 | โบนัส: +${detail.bonusScore || 0}`),
        React.createElement('h3', null, 'Checklist เอกสาร'),
        React.createElement('div', { className: 'checklist' },
          check('README', detail.checklist.readme, v => updateChecklist('readme', v)),
          check('TEAM_SPLIT', detail.checklist.teamSplit, v => updateChecklist('teamSplit', v)),
          check('INDIVIDUAL_REPORT', detail.checklist.individualReport, v => updateChecklist('individualReport', v)),
          check('Screenshots', detail.checklist.screenshots, v => updateChecklist('screenshots', v))
        ),
        React.createElement('h3', null, 'ผล health ล่าสุด'),
        React.createElement('div', { className: 'kv' },
          kv('Frontend', detail.services?.frontend?.label || '-'),
          kv('Auth', detail.services?.auth?.label || '-'),
          kv('Task', detail.services?.task?.label || '-'),
          kv('User', detail.services?.user?.label || '-'),
          kv('Last checked', fmtDate(detail.lastCheckedAt))
        )
      )
    ),
    React.createElement('div', { className: 'section' },
      React.createElement('h3', null, 'Feedback สำหรับนักศึกษา'),
      React.createElement('textarea', { value: detail.studentFeedback, onChange: e => updateDetail('studentFeedback', e.target.value), placeholder: 'ข้อความที่นักศึกษาควรเห็นภายหลัง' }),
      React.createElement('h3', null, 'Private Note ของอาจารย์'),
      React.createElement('textarea', { value: detail.privateNote, onChange: e => updateDetail('privateNote', e.target.value), placeholder: 'บันทึกภายในสำหรับผู้สอน' })
    )
  );
}

function field(label, control) {
  return React.createElement('label', { className: 'field' }, React.createElement('div', { className: 'field-label' }, label), control);
}
function check(label, value, onChange) {
  return React.createElement('label', { className: 'check-item' }, React.createElement('input', { type: 'checkbox', checked: !!value, onChange: e => onChange(e.target.checked) }), label);
}
function kv(k, v) {
  return React.createElement(React.Fragment, null, React.createElement('div', { className: 'k' }, k), React.createElement('div', null, v));
}
function streamLabel(streamState) {
  if (streamState.mode === 'open') return 'connected';
  if (streamState.mode === 'connecting') return 'connecting';
  return 'fallback';
}
function escapeHtml(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

createRoot(document.getElementById('root')).render(React.createElement(App));
