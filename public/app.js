const { useEffect, useMemo, useState } = React;
const { createRoot } = ReactDOM;
const FALLBACK_POLL_MS = 10000;

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

function fmtDate(v) { return v ? new Date(v).toLocaleString('th-TH') : '-'; }
function auditActionLabel(v) { return ({ LOGIN:'เข้าสู่ระบบ', LOGOUT:'ออกจากระบบ', SETUP_GROUP:'บันทึกสมาชิก', SAVE_SUBMISSION:'บันทึกการส่งงาน', CHANGE_STATUS:'เปลี่ยนสถานะ', UPDATE_NOTE:'อัปเดตหมายเหตุ', REVIEW_SAVE:'บันทึก review', CHECK_HEALTH:'เช็ก health', CHECK_ALL_HEALTH:'เช็ก health ทุกกลุ่ม' })[v] || v; }
function studentStatusLabel(v) {
  return ({ draft: 'Draft', in_progress: 'กำลังทำ', submitted_for_review: 'ส่งให้ตรวจ', ready_for_interview: 'พร้อมสัมภาษณ์' })[v] || v;
}
function teacherStatusLabel(v) {
  return ({ not_checked: 'ยังไม่ตรวจ', reviewing: 'กำลังตรวจ', needs_revision: 'ให้แก้ไข', verified: 'ยืนยันแล้ว', interview_scheduled: 'นัดสัมภาษณ์', completed: 'เสร็จสิ้น' })[v] || v;
}
function startStateLabel(v) {
  return ({ not_started: 'ยังไม่เข้าใช้', logged_in: 'เข้าแล้ว', started: 'เริ่มทำแล้ว' })[v] || v;
}
function statusClass(v) {
  if (['verified', 'completed'].includes(v)) return 'ready';
  if (['reviewing', 'interview_scheduled', 'submitted_for_review', 'ready_for_interview', 'in_progress'].includes(v)) return 'partial';
  if (['needs_revision'].includes(v)) return 'failed';
  return 'draft';
}
function startClass(v) {
  if (v === 'started') return 'info';
  if (v === 'logged_in') return 'warn';
  return 'draft';
}
function readinessClass(v) {
  if (v >= 85) return 'ready';
  if (v >= 60) return 'partial';
  if (v >= 35) return 'warn';
  return 'draft';
}
function symClass(v) { if (!v) return 'off'; if (v.ok) return 'ok'; if (v.label === 'N/A') return 'off'; return 'bad'; }
function totalScore(g) { return (g.systemScore || 0) + (g.docsScore || 0) + (g.interviewScore || 0); }
function emptyMembers() { return [{ studentId: '', fullName: '' }, { studentId: '', fullName: '' }, { studentId: '', fullName: '' }]; }
function mockHealthUrl() { return `${window.location.origin}/mock/health`; }

function LoginScreen({ onLogin, loading, message }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="login-shell">
      <div className="login-card panel">
        <div className="login-head">
          <div className="pill">Final usable</div>
          <h1>ENGSE207 Set 2 Monitor</h1>
          <div className="sub">Public board + student workspace + teacher dashboard</div>
        </div>
        <form className="login-form" onSubmit={(e) => { e.preventDefault(); onLogin(username, password); }}>
          <div className="field"><label className="field-label">ชื่อผู้ใช้</label><input value={username} onChange={(e) => setUsername(e.target.value)} /></div>
          <div className="field"><label className="field-label">รหัสผ่าน</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <button className="primary">{loading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}</button>
          {message ? <div className="login-note error">{message}</div> : null}
          <div className="login-note">
            <b>ตัวอย่างกลุ่ม:</b> sec1-group01 / group01pass
          </div>
          <div className="footer-actions" style={{justifyContent:'center'}}>
            <button type="button" className="ghost" onClick={() => window.history.pushState({}, '', '/board') || window.dispatchEvent(new PopStateEvent('popstate'))}>ไปหน้า Board</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SummaryCards({ groups, meta, streamState }) {
  const summary = useMemo(() => ({
    total: groups.length,
    started: groups.filter((g) => g.startState === 'started').length,
    submitted: groups.filter((g) => ['submitted_for_review', 'ready_for_interview'].includes(g.studentStatus)).length,
    recent: groups.filter((g) => g.hasRecentUpdate).length,
    avgReady: groups.length ? Math.round(groups.reduce((s, g) => s + (g.readiness || 0), 0) / groups.length) : 0
  }), [groups]);
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>ภาพรวม Final Lab Set 2</h2>
          <div className="sub">teacher dashboard</div>
        </div>
        <div className="meta-strip">
          <span className={`meta-chip ${streamState.mode === 'open' ? 'good' : 'warn'}`}>Stream: {streamState.mode === 'open' ? 'Live' : 'Fallback'}</span>
          <span className="meta-chip neutral">Auto-check: {meta.checker?.enabled ? 'ON' : 'OFF'}</span>
          <span className="meta-chip neutral">รอบตรวจ: {meta.checker?.intervalMs ? `${Math.round(meta.checker.intervalMs / 1000)}s` : '-'}</span>
        </div>
      </div>
      <div className="panel-body">
        <div className="summary">
          <div className="metric"><div className="k">Groups</div><div className="v">{summary.total}</div></div>
          <div className="metric"><div className="k">Started</div><div className="v">{summary.started}</div></div>
          <div className="metric"><div className="k">Submitted</div><div className="v">{summary.submitted}</div></div>
          <div className="metric"><div className="k">New updates</div><div className="v">{summary.recent}</div></div>
          <div className="metric"><div className="k">Avg Ready</div><div className="v">{summary.avgReady}%</div></div>
        </div>
      </div>
    </div>
  );
}

function GroupCard({ item, active, onClick }) {
  return (
    <div className={`card ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="ultra-top">
        <div className="title-wrap">
          <div className="group-title">{item.groupName}</div>
          <div className="group-meta">{item.section.toUpperCase()} · {item.groupCode.toUpperCase()}</div>
        </div>
        <div className="score-stack">
          <div className="score-main">{item.totalScore || totalScore(item)}<small>/100</small></div>
          <div className="tiny">+{item.bonusScore || 0}</div>
        </div>
      </div>

      <div className="card-badges-row">
        <span className={`badge ${startClass(item.startState)}`}>{startStateLabel(item.startState)}</span>
        <span className={`badge ${statusClass(item.studentStatus)}`}>{studentStatusLabel(item.studentStatus)}</span>
        <span className={`badge ${statusClass(item.teacherStatus)}`}>{teacherStatusLabel(item.teacherStatus)}</span>
        {item.hasRecentUpdate ? <span className="badge info">อัปเดตใหม่</span> : null}
      </div>

      <div className="statline">
        <div className="stats-inline">
          <span className="st"><b>M</b> {item.memberCount}/3</span>
          <span className="st"><b>U</b> {item.urlsCount}/4</span>
          <span className="st"><b>D</b> {item.docsCount}/4</span>
          <span className="st"><b>G</b> {item.repoCount || 0}/2</span>
          <span className={`st ${readinessClass(item.readiness)}`}><b>R</b> {item.readiness}%</span>
        </div>
        <div className="symbols">
          <span className={`sym ${symClass(item.services?.frontend)}`}>F</span>
          <span className={`sym ${symClass(item.services?.auth)}`}>A</span>
          <span className={`sym ${symClass(item.services?.task)}`}>T</span>
          <span className={`sym ${symClass(item.services?.user)}`}>U</span>
        </div>
      </div>

      <div className="bottomline">
        <div className="small">{fmtDate(item.lastStudentUpdateAt || item.updatedAt)}</div>
        <span className="chip-mini">{item.systemScore || 0}/90</span>
      </div>
    </div>
  );
}

function PublicGroupCard({ item }) {
  return (
    <div className="card public-card">
      <div className="ultra-top">
        <div className="title-wrap">
          <div className="group-title">{item.groupName}</div>
          <div className="group-meta">{item.section.toUpperCase()} · {item.groupCode.toUpperCase()}</div>
        </div>
        <div className={`badge ${readinessClass(item.readiness)}`}>R {item.readiness}%</div>
      </div>
      <div className="card-badges-row">
        <span className={`badge ${startClass(item.startState)}`}>{startStateLabel(item.startState)}</span>
        <span className={`badge ${statusClass(item.studentStatus)}`}>{studentStatusLabel(item.studentStatus)}</span>
        <span className={`badge ${statusClass(item.teacherStatus)}`}>{teacherStatusLabel(item.teacherStatus)}</span>
      </div>
      <div className="statline">
        <div className="stats-inline">
          <span className="st"><b>M</b> {item.memberCount}/3</span>
          <span className="st"><b>U</b> {item.urlsCount}/4</span>
          <span className="st"><b>D</b> {item.docsCount}/4</span>
        </div>
        <div className="symbols">
          <span className={`sym ${symClass(item.services?.frontend)}`}>F</span>
          <span className={`sym ${symClass(item.services?.auth)}`}>A</span>
          <span className={`sym ${symClass(item.services?.task)}`}>T</span>
          <span className={`sym ${symClass(item.services?.user)}`}>U</span>
        </div>
      </div>
      <div className="bottomline">
        <div className="small">อัปเดตล่าสุด {fmtDate(item.lastStudentUpdateAt || item.updatedAt)}</div>
        {item.hasRecentUpdate ? <span className="chip-mini warn">new</span> : <span className="chip-mini">&nbsp;</span>}
      </div>
    </div>
  );
}

function PublicBoard() {
  const [groups, setGroups] = useState([]);
  const [meta, setMeta] = useState({});
  const [sectionFilter, setSectionFilter] = useState('all');
  const [search, setSearch] = useState('');

  async function loadBoard() {
    const res = await api('/api/board');
    setGroups(res.items || []);
    setMeta(res.meta || {});
  }

  useEffect(() => { loadBoard().catch(() => {}); const t = setInterval(() => loadBoard().catch(() => {}), 15000); return () => clearInterval(t); }, []);

  const filtered = useMemo(() => groups.filter((g) => {
    if (sectionFilter !== 'all' && g.section !== sectionFilter) return false;
    const hay = [g.groupName, g.section, g.groupCode].join(' ').toLowerCase();
    if (search && !hay.includes(search.toLowerCase())) return false;
    return true;
  }), [groups, sectionFilter, search]);

  return (
    <div className="teacher-shell">
      <SummaryCards groups={filtered} meta={meta} streamState={{mode:'open'}} />
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Board ความคืบหน้าทั้งห้อง</h2>
            <div className="sub">มุมมองสาธารณะสำหรับติดตามความคืบหน้า</div>
          </div>
          <div className="toolbar">
            <select value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)}>
              <option value="all">ทุก section</option>
              <option value="sec1">sec1</option>
              <option value="sec2">sec2</option>
            </select>
            <input placeholder="ค้นหากลุ่ม..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <button className="primary" onClick={() => window.history.pushState({}, '', '/login') || window.dispatchEvent(new PopStateEvent('popstate'))}>เข้าสู่ระบบ</button>
          </div>
        </div>
        <div className="panel-body">
          <div className="cards board-cards">
            {filtered.map((item) => (
              <PublicGroupCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TeacherDashboard({ user, onLogout }) {
  const [groups, setGroups] = useState([]);
  const [meta, setMeta] = useState({ checker: { enabled: true, intervalMs: 60000 } });
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sectionFilter, setSectionFilter] = useState('all');
  const [streamState, setStreamState] = useState({ mode: 'connecting' });
  const [history, setHistory] = useState([]);

  async function loadHistory(id) {
    if (!id) { setHistory([]); return; }
    try {
      const res = await api(`/api/groups/${id}/history`);
      setHistory(res.items || []);
    } catch { setHistory([]); }
  }

  async function loadAll(forceSelectedId) {
    const [gRes, metaRes] = await Promise.all([api('/api/groups'), api('/api/meta')]);
    setGroups(gRes.items || []);
    setMeta(metaRes || {});
    if (!dirty) setSelectedId(forceSelectedId ?? (selectedId || gRes.items?.[0]?.id || null));
  }

  useEffect(() => { loadAll().catch((e) => setMessage(e.message)); }, []);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.addEventListener('snapshot', (e) => {
      const payload = JSON.parse(e.data);
      setGroups(payload.items || []);
      setMeta(payload.meta || {});
      setStreamState({ mode: 'open' });
    });
    es.addEventListener('meta', (e) => {
      const payload = JSON.parse(e.data);
      setMeta(payload.meta || {});
      setStreamState({ mode: 'open' });
    });
    es.onerror = () => setStreamState({ mode: 'fallback' });
    return () => es.close();
  }, []);
  useEffect(() => {
    if (streamState.mode !== 'fallback') return undefined;
    const t = setInterval(() => { if (!dirty) loadAll(); }, FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, [streamState.mode, dirty]);
  useEffect(() => {
    const selected = groups.find((g) => g.id === selectedId);
    if (!selected) return;
    if (dirty && detail?.id === selected.id) return;
    setDetail(JSON.parse(JSON.stringify(selected)));
    loadHistory(selected.id);
  }, [groups, selectedId, dirty]);

  const filtered = useMemo(() => groups.filter((g) => {
    const hay = [g.groupName, g.section, g.groupCode, ...(g.members || []).map((m) => `${m.studentId} ${m.fullName}`)].join(' ').toLowerCase();
    if (search && !hay.includes(search.toLowerCase())) return false;
    if (sectionFilter !== 'all' && g.section !== sectionFilter) return false;
    return true;
  }), [groups, search, sectionFilter]);

  function upd(k, v) { setDirty(true); setDetail((p) => ({ ...p, [k]: v })); }

  async function saveReview() {
    if (!detail?.id) return;
    setLoading(true);
    try {
      const res = await api(`/api/groups/${detail.id}/review`, {
        method: 'PATCH',
        body: JSON.stringify({
          teacherStatus: detail.teacherStatus,
          teacherFeedback: detail.teacherFeedback,
          privateNote: detail.privateNote,
          systemScore: detail.systemScore,
          docsScore: detail.docsScore,
          interviewScore: detail.interviewScore,
          bonusScore: detail.bonusScore
        })
      });
      setDirty(false);
      setDetail(res.item);
      setMessage('บันทึกการยืนยันแล้ว');
      loadHistory(res.item.id);
    } catch (e) {
      setMessage(e.message);
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(''), 2500);
    }
  }
  async function checkOne() {
    if (!detail?.id) return;
    setLoading(true);
    try {
      const res = await api(`/api/groups/${detail.id}/check-health`, { method: 'POST' });
      setDirty(false);
      setDetail(res.item);
      setMessage('เช็ก health แล้ว');
      loadHistory(res.item.id);
    } catch (e) { setMessage(e.message); }
    finally { setLoading(false); setTimeout(() => setMessage(''), 2500); }
  }
  async function checkAll() {
    setLoading(true);
    try { await api('/api/check-all', { method: 'POST' }); }
    catch (e) { setMessage(e.message); }
    finally { setLoading(false); }
  }
  async function toggleChecker() {
    setLoading(true);
    try { await api('/api/meta/checker', { method: 'POST', body: JSON.stringify({ enabled: !meta.checker?.enabled }) }); }
    catch (e) { setMessage(e.message); }
    finally { setLoading(false); }
  }
  async function exportJson() {
    const data = await api('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'set2-monitor-export.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="app">
      <div className="left">
        <SummaryCards groups={groups} meta={meta} streamState={streamState} />
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Teacher Dashboard</h2>
              <div className="sub">{user.displayName}</div>
            </div>
            <div className="footer-actions">
              <button onClick={checkAll}>เช็กทุกกลุ่ม</button>
              <button onClick={toggleChecker}>{meta.checker?.enabled ? 'ปิด Auto-check' : 'เปิด Auto-check'}</button>
              <button className="soft" onClick={exportJson}>Export JSON</button>
              <button className="warn" onClick={onLogout}>ออกจากระบบ</button>
            </div>
          </div>
          <div className="panel-body">
            <div className="toolbar phase2">
              <input placeholder="ค้นหากลุ่ม / สมาชิก / sec" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)}>
                <option value="all">ทุก section</option>
                <option value="sec1">sec1</option>
                <option value="sec2">sec2</option>
              </select>
              <div className="muted-box">{filtered.length} กลุ่ม</div>
            </div>
            <div className="cards" style={{ marginTop: 12 }}>
              {filtered.map((g) => <GroupCard key={g.id} item={g} active={g.id === selectedId} onClick={() => { setSelectedId(g.id); setDirty(false); }} />)}
            </div>
          </div>
        </div>
      </div>
      <div className="right">
        <div className="panel sticky-panel">
          <div className="panel-head">
            <div>
              <h2>{detail?.groupName || 'เลือกรายการกลุ่ม'}</h2>
              <div className="sub">{detail ? `${detail.section.toUpperCase()} · ${detail.groupCode.toUpperCase()}` : '—'}</div>
            </div>
            <div className="footer-actions">
              {detail?.id ? <button onClick={checkOne}>เช็ก health</button> : null}
              {detail?.id ? <button className="primary" onClick={saveReview}>{loading ? 'กำลังบันทึก...' : 'บันทึก review'}</button> : null}
            </div>
          </div>
          <div className="panel-body">
            {!detail ? <div className="muted-box">เลือกกลุ่มทางซ้ายเพื่อดูรายละเอียด</div> : (
              <div className="section">
                <div className="kv">
                  <div className="k">Start status</div><div><span className={`badge ${startClass(detail.startState)}`}>{startStateLabel(detail.startState)}</span></div>
                  <div className="k">Student status</div><div><span className={`badge ${statusClass(detail.studentStatus)}`}>{studentStatusLabel(detail.studentStatus)}</span></div>
                  <div className="k">Teacher status</div><div><span className={`badge ${statusClass(detail.teacherStatus)}`}>{teacherStatusLabel(detail.teacherStatus)}</span></div>
                  <div className="k">Recent update</div><div>{detail.hasRecentUpdate ? <span className="badge info">มีการอัปเดตใหม่</span> : '-'}</div>
                  <div className="k">สมาชิก</div><div>{detail.memberCount}/3 — {detail.members.length ? detail.members.map((m) => `${m.studentId} ${m.fullName}`.trim()).join(', ') : '-'}</div>
                  <div className="k">URLs / Docs</div><div>{detail.urlsCount}/4 · {detail.docsCount}/4</div>
                  <div className="k">Readiness</div><div><span className={`badge ${readinessClass(detail.readiness)}`}>{detail.readiness}%</span></div>
                  <div className="k">เข้าใช้ล่าสุด</div><div>{fmtDate(detail.lastStudentLoginAt)}</div>
                  <div className="k">อัปเดตนักศึกษาล่าสุด</div><div>{fmtDate(detail.lastStudentUpdateAt)}</div>
                  <div className="k">review ล่าสุด</div><div>{fmtDate(detail.lastTeacherReviewAt)}</div>
                  <div className="k">health ล่าสุด</div><div>{fmtDate(detail.lastCheckedAt)}</div>
                </div>

                <div className="detail-grid">
                  <div className="note"><b>Frontend</b><br />{detail.urls.frontend ? <a href={detail.urls.frontend} target="_blank">{detail.urls.frontend}</a> : '-'}</div>
                  <div className="note"><b>Auth</b><br />{detail.urls.auth ? <a href={detail.urls.auth} target="_blank">{detail.urls.auth}</a> : '-'}</div>
                  <div className="note"><b>Task</b><br />{detail.urls.task ? <a href={detail.urls.task} target="_blank">{detail.urls.task}</a> : '-'}</div>
                  <div className="note"><b>User</b><br />{detail.urls.user ? <a href={detail.urls.user} target="_blank">{detail.urls.user}</a> : '-'}</div>
                </div>
                <div className="detail-grid">
                  <div className="note"><b>README</b><br />{detail.docs.readme ? <a href={detail.docs.readme} target="_blank">{detail.docs.readme}</a> : '-'}</div>
                  <div className="note"><b>TEAM_SPLIT</b><br />{detail.docs.teamSplit ? <a href={detail.docs.teamSplit} target="_blank">{detail.docs.teamSplit}</a> : '-'}</div>
                  <div className="note"><b>INDIVIDUAL_REPORT</b><br />{detail.docs.individualReport ? <a href={detail.docs.individualReport} target="_blank">{detail.docs.individualReport}</a> : '-'}</div>
                  <div className="note"><b>Screenshots</b><br />{detail.docs.screenshots ? <a href={detail.docs.screenshots} target="_blank">{detail.docs.screenshots}</a> : '-'}</div>
                </div>
                <div className="detail-grid">
                  <div className="note"><b>Set 1 Repo</b><br />{detail.repoUrls?.set1 ? <a href={detail.repoUrls.set1} target="_blank">{detail.repoUrls.set1}</a> : '-'}</div>
                  <div className="note"><b>Set 2 Repo</b><br />{detail.repoUrls?.set2 ? <a href={detail.repoUrls.set2} target="_blank">{detail.repoUrls.set2}</a> : '-'}</div>
                  <div className="note"><b>Health ผ่าน</b><br />{detail.servicesOk}/4</div>
                  <div className="note"><b>ผลตรวจล่าสุด</b><br />{detail.lastCheckedAt ? fmtDate(detail.lastCheckedAt) : '-'}</div>
                </div>
                <div className="note"><b>หมายเหตุจากนักศึกษา</b><br />{detail.studentNote || '-'}</div>

                <div className="field">
                  <label className="field-label">สถานะยืนยันของอาจารย์</label>
                  <select value={detail.teacherStatus} onChange={(e) => upd('teacherStatus', e.target.value)}>
                    <option value="not_checked">ยังไม่ตรวจ</option>
                    <option value="reviewing">กำลังตรวจ</option>
                    <option value="needs_revision">ให้แก้ไข</option>
                    <option value="verified">ยืนยันแล้ว</option>
                    <option value="interview_scheduled">นัดสัมภาษณ์</option>
                    <option value="completed">เสร็จสิ้น</option>
                  </select>
                </div>
                <div className="score-grid">
                  <div className="field"><label className="field-label">ระบบ /90</label><input type="number" min="0" max="90" value={detail.systemScore || 0} onChange={(e) => upd('systemScore', e.target.value)} /></div>
                  <div className="field"><label className="field-label">เอกสาร /5</label><input type="number" min="0" max="5" value={detail.docsScore || 0} onChange={(e) => upd('docsScore', e.target.value)} /></div>
                  <div className="field"><label className="field-label">สัมภาษณ์ /5</label><input type="number" min="0" max="5" value={detail.interviewScore || 0} onChange={(e) => upd('interviewScore', e.target.value)} /></div>
                  <div className="field"><label className="field-label">โบนัส</label><input type="number" min="0" value={detail.bonusScore || 0} onChange={(e) => upd('bonusScore', e.target.value)} /></div>
                </div>
                <div className="field"><label className="field-label">Feedback ถึงนักศึกษา</label><textarea value={detail.teacherFeedback || ''} onChange={(e) => upd('teacherFeedback', e.target.value)} /></div>
                <div className="field"><label className="field-label">Private note</label><textarea value={detail.privateNote || ''} onChange={(e) => upd('privateNote', e.target.value)} /></div>
                <div className="note">
                  <b>ประวัติการอัปเดตล่าสุด</b>
                  <div className="history-list">
                    {history.length ? history.map((h) => (
                      <div key={h.id} className="history-item">
                        <div><b>{auditActionLabel(h.action)}</b> · {h.actorUsername}</div>
                        <div className="tiny">{fmtDate(h.createdAt)}</div>
                        <div className="compact-note">{h.summary}</div>
                      </div>
                    )) : <div className="compact-note">ยังไม่มีประวัติ</div>}
                  </div>
                </div>
                {message ? <div className="pill">{message}</div> : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MemberFields({ members, setMembers }) {
  function update(idx, key, value) {
    const next = members.map((m, i) => (i === idx ? { ...m, [key]: value } : m));
    setMembers(next);
  }
  return (
    <div className="detail-grid">
      {members.map((m, idx) => (
        <div className="panel panel-embed" key={idx}>
          <div className="panel-head"><h3>สมาชิก {idx + 1}{idx === 2 ? ' (optional)' : ''}</h3></div>
          <div className="panel-body section">
            <div className="field"><label className="field-label">รหัสนักศึกษา</label><input value={m.studentId} onChange={(e) => update(idx, 'studentId', e.target.value)} /></div>
            <div className="field"><label className="field-label">ชื่อ-นามสกุล</label><input value={m.fullName} onChange={(e) => update(idx, 'fullName', e.target.value)} /></div>
          </div>
        </div>
      ))}
    </div>
  );
}

function StudentDashboard({ user, onLogout }) {
  const [group, setGroup] = useState(null);
  const [draft, setDraft] = useState(null);
  const [members, setMembers] = useState(emptyMembers());
  const [streamState, setStreamState] = useState({ mode: 'connecting' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState([]);

  async function loadHistory() {
    try {
      const res = await api('/api/me/group/history');
      setHistory(res.items || []);
    } catch { setHistory([]); }
  }

  async function loadMine() {
    const gRes = await api('/api/me/group');
    setGroup(gRes.item || null);
    if (!dirty) {
      setDraft(gRes.item || null);
      const nextMembers = (gRes.item?.members || []).concat(emptyMembers()).slice(0, 3).map((m) => ({ studentId: m.studentId || '', fullName: m.fullName || '' }));
      setMembers(nextMembers);
    }
  }
  useEffect(() => { loadMine().catch((e) => setMessage(e.message)); loadHistory(); }, []);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.addEventListener('snapshot', async (e) => {
      const payload = JSON.parse(e.data);
      const wantedId = user.groupId || `${user.section}-${user.groupCode}`;
      let item = payload.item || null;
      if (!item && Array.isArray(payload.items)) {
        item = payload.items.find((g) => g && (g.id === wantedId || (g.section === user.section && g.groupCode === user.groupCode))) || null;
      }
      if (!item || (wantedId && item.id !== wantedId)) {
        try {
          const fresh = await api('/api/me/group');
          item = fresh.item || null;
        } catch {}
      }
      if (!item) return;
      setGroup(item);
      if (!dirty) {
        setDraft(item);
        const nextMembers = (item?.members || []).concat(emptyMembers()).slice(0, 3).map((m) => ({ studentId: m.studentId || '', fullName: m.fullName || '' }));
        setMembers(nextMembers);
      }
      setStreamState({ mode: 'open' });
    });
    es.onerror = () => setStreamState({ mode: 'fallback' });
    return () => es.close();
  }, [dirty]);
  useEffect(() => {
    if (streamState.mode !== 'fallback') return undefined;
    const t = setInterval(() => { if (!dirty) loadMine(); }, FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, [streamState.mode, dirty]);

  const selected = draft || group;
  function upd(k, v) { setDirty(true); setDraft((p) => ({ ...(p || {}), [k]: v })); }
  function updateUrl(key, value) { setDirty(true); setDraft((p) => ({ ...(p || {}), urls: { ...(p?.urls || {}), [key]: value } })); }
  function updateDoc(key, value) { setDirty(true); setDraft((p) => ({ ...(p || {}), docs: { ...(p?.docs || {}), [key]: value } })); }
  function applyMockHealthUrls() {
    const mock = mockHealthUrl();
    setDirty(true);
    setDraft((p) => ({ ...(p || {}), urls: { ...(p?.urls || {}), frontend: mock, auth: mock, task: mock, user: mock } }));
    setMessage(`ใส่ URL ทดสอบแล้ว: ${mock}`);
    setTimeout(() => setMessage(''), 2500);
  }

  async function saveSetup() {
    const res = await api('/api/me/group/setup', { method: 'PATCH', body: JSON.stringify({ members, groupName: selected.groupName }) });
    setGroup(res.item); setDraft(res.item);
    const nextMembers = (res.item?.members || []).concat(emptyMembers()).slice(0, 3).map((m) => ({ studentId: m.studentId || '', fullName: m.fullName || '' }));
    setMembers(nextMembers);
    return res.item;
  }

  async function saveAll() {
    if (!selected) return;
    setLoading(true);
    try {
      let item = await saveSetup();
      const subRes = await api('/api/me/group/submission', {
        method: 'PATCH',
        body: JSON.stringify({
          frontendUrl: selected.urls?.frontend || '',
          authUrl: selected.urls?.auth || '',
          taskUrl: selected.urls?.task || '',
          userUrl: selected.urls?.user || '',
          readmeUrl: selected.docs?.readme || '',
          teamSplitUrl: selected.docs?.teamSplit || '',
          individualReportUrl: selected.docs?.individualReport || '',
          screenshotsUrl: selected.docs?.screenshots || '',
          set1RepoUrl: selected.repoUrls?.set1 || '',
          set2RepoUrl: selected.repoUrls?.set2 || '',
          studentNote: selected.studentNote || ''
        })
      });
      item = subRes.item;
      const statusRes = await api('/api/me/group/status', { method: 'PATCH', body: JSON.stringify({ studentStatus: selected.studentStatus || 'draft' }) });
      item = statusRes.item;
      setGroup(item);
      setDraft(item);
      setDirty(false);
      setMessage('บันทึกข้อมูลเรียบร้อยแล้ว');
      loadHistory();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(''), 2500);
    }
  }

  if (!selected) return <div className="student-shell"><div className="muted-box">กำลังโหลด...</div></div>;

  return (
    <div className="student-shell">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h1>{selected.groupName}</h1>
            <div className="sub">{selected.section.toUpperCase()} · {selected.groupCode.toUpperCase()} · {user.username}</div>
          </div>
          <div className="footer-actions">
            <span className={`meta-chip ${streamState.mode === 'open' ? 'good' : 'warn'}`}>Stream: {streamState.mode === 'open' ? 'Live' : 'Fallback'}</span>
            <button className="warn" onClick={onLogout}>ออกจากระบบ</button>
          </div>
        </div>
        <div className="panel-body">
          <div className="summary student-cards">
            <div className="metric"><div className="k">Start</div><div className="v small-v"><span className={`badge ${startClass(selected.startState)}`}>{startStateLabel(selected.startState)}</span></div></div>
            <div className="metric"><div className="k">Student</div><div className="v small-v"><span className={`badge ${statusClass(selected.studentStatus)}`}>{studentStatusLabel(selected.studentStatus)}</span></div></div>
            <div className="metric"><div className="k">Teacher</div><div className="v small-v"><span className={`badge ${statusClass(selected.teacherStatus)}`}>{teacherStatusLabel(selected.teacherStatus)}</span></div></div>
            <div className="metric"><div className="k">Ready</div><div className="v">{selected.readiness}%</div></div>
            <div className="metric"><div className="k">URLs / Docs</div><div className="v">{selected.urlsCount}/4 · {selected.docsCount}/4</div></div>
            <div className="metric"><div className="k">คะแนนรวม</div><div className="v">{selected.totalScore || totalScore(selected)}<small>/100</small><div className="tiny">+{selected.bonusScore || 0}</div></div></div>
          </div>

          <div className="student-detail-grid">
            <div className="panel student-panel">
              <div className="panel-head"><h2>{selected.initialized ? 'ข้อมูลสมาชิกกลุ่ม' : 'ตั้งค่ากลุ่มครั้งแรก'}</h2></div>
              <div className="panel-body section">
                <div className="field"><label className="field-label">ชื่อกลุ่มแสดงผล</label><input value={selected.groupName || ''} onChange={(e) => upd('groupName', e.target.value)} /></div>
                <MemberFields members={members} setMembers={setMembers} />
              </div>
            </div>

            <div className="panel student-panel sticky-panel">
              <div className="panel-head"><h2>ส่งงานและสถานะ</h2></div>
              <div className="panel-body section">
                <div className="field">
                  <label className="field-label">สถานะของกลุ่ม (เปลี่ยนกลับได้)</label>
                  <select value={selected.studentStatus || 'draft'} onChange={(e) => upd('studentStatus', e.target.value)}>
                    <option value="draft">Draft</option>
                    <option value="in_progress">กำลังทำ</option>
                    <option value="submitted_for_review">ส่งให้ตรวจ</option>
                    <option value="ready_for_interview">พร้อมสัมภาษณ์</option>
                  </select>
                </div>
                <div className="detail-grid">
                  <div className="field"><label className="field-label">Frontend URL</label><input value={selected.urls?.frontend || ''} onChange={(e) => updateUrl('frontend', e.target.value)} /></div>
                  <div className="field"><label className="field-label">Auth URL</label><input value={selected.urls?.auth || ''} onChange={(e) => updateUrl('auth', e.target.value)} /></div>
                  <div className="field"><label className="field-label">Task URL</label><input value={selected.urls?.task || ''} onChange={(e) => updateUrl('task', e.target.value)} /></div>
                  <div className="field"><label className="field-label">User URL</label><input value={selected.urls?.user || ''} onChange={(e) => updateUrl('user', e.target.value)} /></div>
                </div>
                <div className="note"><b>Mock health สำหรับทดลอง</b><br />ใช้ <code>{mockHealthUrl()}</code> ได้ทันที หรือกดปุ่มด้านล่างเพื่อใส่ครบทั้ง 4 ช่อง</div>
                <div className="footer-actions" style={{marginTop:'-4px', marginBottom:'10px'}}>
                  <button className="ghost" type="button" onClick={applyMockHealthUrls}>ใส่ mock health ทั้ง 4 ช่อง</button>
                </div>
                <div className="detail-grid">
                  <div className="field"><label className="field-label">README URL</label><input value={selected.docs?.readme || ''} onChange={(e) => updateDoc('readme', e.target.value)} /></div>
                  <div className="field"><label className="field-label">TEAM_SPLIT URL</label><input value={selected.docs?.teamSplit || ''} onChange={(e) => updateDoc('teamSplit', e.target.value)} /></div>
                  <div className="field"><label className="field-label">INDIVIDUAL_REPORT URL</label><input value={selected.docs?.individualReport || ''} onChange={(e) => updateDoc('individualReport', e.target.value)} /></div>
                  <div className="field"><label className="field-label">Screenshots URL</label><input value={selected.docs?.screenshots || ''} onChange={(e) => updateDoc('screenshots', e.target.value)} /></div>
                </div>
                <div className="detail-grid">
                  <div className="field"><label className="field-label">Set 1 Repo URL</label><input value={selected.repoUrls?.set1 || ''} onChange={(e) => upd('repoUrls', { ...(selected.repoUrls || {}), set1: e.target.value, set2: selected.repoUrls?.set2 || '' })} /></div>
                  <div className="field"><label className="field-label">Set 2 Repo URL</label><input value={selected.repoUrls?.set2 || ''} onChange={(e) => upd('repoUrls', { ...(selected.repoUrls || {}), set2: e.target.value, set1: selected.repoUrls?.set1 || '' })} /></div>
                </div>
                <div className="field"><label className="field-label">หมายเหตุถึงอาจารย์</label><textarea value={selected.studentNote || ''} onChange={(e) => upd('studentNote', e.target.value)} /></div>
                <div className="score-grid">
                  <div className="note"><b>คะแนนระบบ</b><br />{selected.systemScore || 0}/90</div>
                  <div className="note"><b>คะแนนเอกสาร</b><br />{selected.docsScore || 0}/5</div>
                  <div className="note"><b>คะแนนสัมภาษณ์</b><br />{selected.interviewScore || 0}/5</div>
                  <div className="note"><b>คะแนนโบนัส</b><br />+{selected.bonusScore || 0}</div>
                </div>
                <div className="note"><b>Feedback จากอาจารย์</b><br />{selected.teacherFeedback || '-'}</div>
                <div className="note">
                  <b>ประวัติการอัปเดตล่าสุด</b>
                  <div className="history-list">
                    {history.length ? history.map((h) => (
                      <div key={h.id} className="history-item">
                        <div><b>{auditActionLabel(h.action)}</b> · {h.actorUsername}</div>
                        <div className="tiny">{fmtDate(h.createdAt)}</div>
                        <div className="compact-note">{h.summary}</div>
                      </div>
                    )) : <div className="compact-note">ยังไม่มีประวัติ</div>}
                  </div>
                </div>
                {message ? <div className="pill">{message}</div> : null}
                <div className="footer-actions">
                  <button className="primary" onClick={saveAll}>{loading ? 'กำลังบันทึก...' : 'บันทึกข้อมูลทั้งหมด'}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [route, setRoute] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function navigate(path) {
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
      setRoute(path);
    }
  }

  useEffect(() => {
    api('/api/auth/me').then((res) => setUser(res.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  async function login(username, password) {
    setLoading(true);
    setMessage('');
    try {
      const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      setUser(res.user);
      navigate(res.user.role === 'teacher' ? '/teacher' : '/student');
    } catch (e) {
      setMessage(e.message);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    setUser(null);
    navigate('/login');
  }

  if (loading && !user) return <LoginScreen onLogin={login} loading={true} message={message} />;

  if (route === '/' || route === '/board') return <PublicBoard />;

  if (!user) return <LoginScreen onLogin={login} loading={false} message={message} />;

  if (route === '/teacher') {
    if (user.role !== 'teacher') { navigate('/student'); return null; }
    return <TeacherDashboard user={user} onLogout={logout} />;
  }

  if (route === '/student' || route === '/login') {
    if (user.role === 'teacher') { navigate('/teacher'); return null; }
    return <StudentDashboard user={user} onLogout={logout} />;
  }

  return <PublicBoard />;
}

createRoot(document.getElementById('root')).render(<App />);
