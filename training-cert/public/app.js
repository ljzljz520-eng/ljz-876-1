'use strict';
/* ================= 基础工具 ================= */
const root = (typeof window !== 'undefined' ? window : globalThis);
const doc = root.document;
const storage = root.localStorage;
const loc = root.location;
const fetchApi = (...args) => root.fetch(...args);
const $app = doc.getElementById('app');
const $toast = doc.getElementById('toast');
let state = { token: storage.getItem('token') || null, user: null, route: null };

function toast(msg, isErr = false) {
  $toast.textContent = msg;
  $toast.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { $toast.className = 'toast'; }, 2800);
}

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (state.token) opt.headers.Authorization = 'Bearer ' + state.token;
  const res = await fetchApi('/api' + url, opt);
  let data = null;
  try { data = await res.json(); } catch (e) { /* noop */ }
  if (!res.ok) {
    if (res.status === 401) { logout(false); }
    throw new Error((data && data.error) || '请求失败 (' + res.status + ')');
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_CN = {
  present: '正常', late: '迟到', absent: '缺课', makeup: '补签',
  pending: '待审核', approved: '已批准', rejected: '已驳回',
  valid: '有效', invalidated: '已失效', initial: '首发', reissue: '补发',
};
function badge(status, text) {
  return `<span class="badge b-${esc(status)}"><span class="dot"></span>${esc(text || STATUS_CN[status] || status)}</span>`;
}

function fmtDT(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toLocalInput(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function pct(x) { return Math.round(x * 100); }
function attBarClass(r) { return r >= 0.8 ? '' : r >= 0.6 ? 'mid' : 'low'; }

function logout(redir = true) {
  state.token = null; state.user = null; storage.removeItem('token');
  if (redir) location.hash = '#/login';
}

function modal(html) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">${html}</div>`;
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);
  return mask;
}
function closeModal() { document.querySelector('.modal-mask')?.remove(); }

/* ================= 路由 ================= */
root.addEventListener('hashchange', render);
let renderSeq = 0;
async function render() {
  const mySeq = ++renderSeq;
  const stale = () => mySeq !== renderSeq;
  const hash = loc.hash || '#/';
  if (hash.startsWith('#/verify/') || hash === '#/verify') {
    return renderVerify(hash.startsWith('#/verify/') ? decodeURIComponent(hash.slice('#/verify/'.length)) : '');
  }
  if (!state.token) {
    if (hash === '#/register') return renderRegister();
    return renderLogin();
  }
  if (!state.user) {
    try { state.user = await api('GET', '/auth/me'); } catch (e) { if (!stale()) renderLogin(); return; }
  }
  if (stale()) return; // 已被更新的导航取代，丢弃本次过期渲染
  if (state.user.role === 'organizer') return renderOrganizer(hash);
  return renderStudent(hash);
}

function topbar(active) {
  const isOrg = state.user.role === 'organizer';
  const links = isOrg
    ? [['#/', '工作台'], ['#/courses/new', '新建课程'], ['#/makeups', '补签审批'], ['#/audit', '操作审计']]
    : [['#/', '我的课程'], ['#/checkin', '扫码签到'], ['#/certs', '我的证书'], ['#/explore', '课程广场']];
  return `<div class="topbar">
    <a class="brand" href="#/"><span class="logo">证</span>培证通</a>
    <div class="spacer"></div>
    <nav class="nav-links">${links.map(([h, t]) =>
      `<a href="${h}" class="${active === h ? 'active' : ''}">${t}</a>`).join('')}</nav>
    <span class="user"><b>${esc(state.user.name)}</b> · ${isOrg ? '主办方' : '学员'}</span>
    <button class="btn btn-sm" onclick="doLogout()">退出</button>
  </div>`;
}
window.doLogout = async () => { try { await api('POST', '/auth/logout'); } catch (e) {} logout(); };

/* ================= 登录 / 注册 ================= */
function authShell(tab) {
  return `<div class="auth-wrap"><div class="auth-box">
    <div class="brand"><span class="logo">证</span>培证通</div>
    <div class="tagline">培训签到 · 测验结业 · 证书发放与补发追溯</div>
    <div class="auth-tabs">
      <button class="${tab === 'login' ? 'active' : ''}" onclick="location.hash='#/login'">登录</button>
      <button class="${tab === 'register' ? 'active' : ''}" onclick="location.hash='#/register'">学员注册</button>
    </div>
    <form id="authForm">
      ${tab === 'register' ? '<label class="fld"><span>姓名</span><input name="name" required placeholder="真实姓名"></label>' : ''}
      <label class="fld"><span>手机号</span><input name="phone" type="tel" required placeholder="手机号"></label>
      <label class="fld"><span>密码</span><input name="password" type="password" required placeholder="密码"></label>
      <button class="btn btn-primary" style="width:100%;justify-content:center;padding:11px">
        ${tab === 'login' ? '登 录' : '注册并登录'}</button>
    </form>
    <div class="demo-hint">
      演示账号（密码均为 <code>123456</code>）：<br>
      主办方 <code>13000000001</code> 王老师<br>
      学&nbsp;&nbsp;员 <code>13800000001</code> 张伟（已结业）<br>
      &nbsp;&nbsp;&nbsp;&;&nbsp;&nbsp;&nbsp;<code>13800000003</code> 王强（缺课/待补签）
    </div>
  </div></div>`;
}

function renderLogin() {
  $app.innerHTML = authShell('login');
  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await fetchApi('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: f.get('phone'), password: f.get('password') }),
      }).then((x) => x.json().then((d) => ({ ok: x.ok, d })));
      if (!r.ok) throw new Error(r.d.error);
      state.token = r.d.token; state.user = r.d.user;
      storage.setItem('token', state.token);
      location.hash = '#/';
      toast('登录成功');
    } catch (err) { toast(err.message, true); }
  });
}

function renderRegister() {
  $app.innerHTML = authShell('register');
  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const d = await api('POST', '/auth/register-student',
        { name: f.get('name'), phone: f.get('phone'), password: f.get('password') });
      state.token = d.token; state.user = d.user;
      storage.setItem('token', state.token);
      location.hash = '#/';
      toast('注册成功');
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= 落地页（公开） ================= */
function renderLanding() {
  $app.innerHTML = `<div class="hero"><div class="hero-inner">
    <h1>培训签到与证书管理一体化平台</h1>
    <p>主办方一键创建课程、课次与动态签到码；学员扫码签到、参加结业测验；
    达标后颁发可公开查验的电子证书。迟到、缺课、补签全程留痕，证书作废与补发原因永久可追溯。</p>
    <div class="actions">
      <button class="btn btn-primary" onclick="location.hash='#/login'">进入平台</button>
      <button class="btn btn-outline" onclick="location.hash='#/verify'">查验证书</button>
    </div></div></div>
  <div class="container">
    <div class="grid grid-3">
      ${[['📱', '动态签到码', '每节课生成 6 位一次性签到码与二维码，支持一键轮换；按开课时点自动判定正常 / 迟到 / 缺课。'],
      ['📝', '结业双达标', '出勤率（迟到折半计）与在线测验双过线才具备结业资格，成绩多次取最高。'],
      ['🏅', '证书可追溯', '首发 / 补发状态清晰，旧证作废原因与换发链永久保存，扫码即可公开查验。']]
      .map(([i, t, d]) => `<div class="card"><div style="font-size:26px">${i}</div>
        <h2 style="margin:8px 0">${t}</h2><div class="muted">${d}</div></div>`).join('')}
    </div>
    <div class="card text-center">
      <div class="muted mb">快速查验一张演示证书：</div>
      <div class="switchline" style="justify-content:center">
        <button class="btn" onclick="location.hash='#/verify/CERT-2026-A0005'">有效补发证书 A0005</button>
        <button class="btn" onclick="location.hash='#/verify/CERT-2026-A0002'">已失效旧证 A0002</button>
        <button class="btn" onclick="location.hash='#/verify/CERT-2026-A0004'">已撤销证书 A0004</button>
      </div>
    </div>
  </div>`;
}

/* ================= 公开查验 ================= */
async function renderVerify(certNo) {
  $app.innerHTML = `<div class="topbar">
    <a class="brand" href="#/"><span class="logo">证</span>培证通</a><div class="spacer"></div>
    <a class="btn btn-sm" href="#/login">登录平台</a></div>
  <div class="container" style="max-width:860px">
    <div class="card"><h2>证书公开查验</h2>
      <form id="verifyForm" class="row">
        <input name="certNo" placeholder="输入证书编号，如 CERT-2026-A0005" value="${esc(certNo)}" style="flex:2">
        <button class="btn btn-primary" style="flex:0 0 auto">查 验</button>
      </form></div>
    <div id="verifyResult"></div></div>`;
  const form = document.getElementById('verifyForm');
  const out = document.getElementById('verifyResult');
  async function doVerify(no) {
    if (!no) { out.innerHTML = ''; return; }
    out.innerHTML = '<div class="empty">查验中…</div>';
    try {
      const d = await api('GET', '/verify/' + encodeURIComponent(no.trim().toUpperCase()));
      out.innerHTML = verifyResultHTML(d);
    } catch (e) {
      out.innerHTML = `<div class="card"><div class="empty"><div class="icon">🚫</div>${esc(e.message)}
        <div class="muted mt">请确认证书编号是否正确。注意：已失效/撤销的证书也可查验到历史记录。</div></div></div>`;
    }
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const no = new FormData(form).get('certNo');
    location.hash = '#/verify/' + encodeURIComponent(no.trim().toUpperCase());
    doVerify(no);
  });
  if (certNo) doVerify(certNo);
}

function verifyResultHTML(d) {
  const c = d.certificate;
  const valid = c.status === 'valid';
  const stamp = valid
    ? '<div class="stamp valid">验真<br>有效</div>'
    : '<div class="stamp">已失效<br>VOID</div>';
  const chain = d.chain.map((x, i) => `
    <li class="${x.status === 'invalidated' ? 'invalid' : ''}">
      <div class="flex-between">
        <b>${esc(x.certNo)}</b> ${badge(x.status)} ${badge(x.issueReason)}
      </div>
      <div class="muted">签发：${fmtDT(x.createdAt)}${x.invalidatedAt ? ' ｜ 失效：' + fmtDT(x.invalidatedAt) : ''}</div>
      ${x.invalidateReason ? `<div style="margin-top:4px">失效原因：<b style="color:var(--red)">${esc(x.invalidateReason)}</b></div>` : ''}
      ${x.events.length ? `<div class="muted mt" style="font-size:12px">${x.events.map(ev =>
        AUDIT_ACTION_CN[ev.action] || ev.action).join('；')}</div>` : ''}
      ${i < d.chain.length - 1 ? '<div class="muted" style="font-size:12px">⬇ 被以下新证替换</div>' : ''}
    </li>`).join('');
  return `
  <div class="card">
    <div class="flex-between mb">
      <h2 style="margin:0">查验结果</h2>
      ${valid ? badge('valid', '该证书当前有效') : badge('invalidated', '该证书已失效（历史记录仍可查验）')}
    </div>
    <div class="cert-paper" style="--c:${esc(c.accentColor)}">
      <div class="cert-org">${esc(c.orgName)}</div>
      <div class="cert-title">${esc(c.tplTitle)}</div>
      <div class="cert-sub">${esc(c.subtitle || '')}</div>
      <div class="cert-body">兹证明学员</div>
      <div class="cert-name">${esc(c.studentName)}</div>
      <div class="cert-body">已完成《${esc(c.courseTitle)}》全部培训环节，特发此证。</div>
      <div class="cert-foot">
        <div class="cert-sign"><b>${esc(c.signerName)}</b><span>${esc(c.signerTitle || '')}</span></div>
        <div style="text-align:right">
          <div class="cert-no">证书编号：${esc(c.certNo)}</div>
          <div class="cert-no">签发日期：${fmtDT(c.createdAt).slice(0, 10)}</div>
        </div>
      </div>
      ${stamp}
    </div>
  </div>
  <div class="card">
    <h2>🔗 证书换发链与操作记录</h2>
    <ul class="timeline">${chain}</ul>
    <div class="flex-between mt">
      <div class="muted" style="font-size:12px">查验链接：${esc(d.verifyUrl)}</div>
      <img src="${d.qrDataUrl}" width="96" height="96" alt="查验二维码" style="border:1px solid var(--line);border-radius:8px">
    </div>
  </div>`;
}

const AUDIT_ACTION_CN = {
  course_created: '创建课程', course_updated: '更新课程', session_created: '创建课次',
  code_rotated: '轮换签到码', checkin: '学员签到', auto_mark_absent: '系统标记缺课',
  student_enrolled: '主办方报名', student_self_enrolled: '学员自助报名',
  makeup_requested: '提交补签申请', makeup_approved: '批准补签', makeup_rejected: '驳回补签',
  quiz_saved: '保存测验', quiz_submitted: '提交测验',
  template_saved: '保存证书样式', cert_issued: '颁发证书', cert_reissued: '补发证书',
  cert_invalidated: '证书作废',
};

/* ================= 主办方：工作台 ================= */
async function renderOrganizer(hash) {
  if (hash === '#/courses/new') return orgNewCourse();
  const m = hash.match(/^#\/courses\/(\d+)(?:\/(.*))?$/);
  if (m) return orgCourseDetail(Number(m[1]), m[2] || '');
  if (hash === '#/makeups') return orgMakeups();
  if (hash === '#/audit') return orgAudit();
  $app.innerHTML = topbar('#/') + '<div class="container"><div class="empty">加载中…</div></div>';
  let d;
  try { d = await api('GET', '/organizer/dashboard'); }
  catch (e) { $app.innerHTML = topbar('#/') + `<div class="container"><div class="card empty">${esc(e.message)}</div></div>`; return; }
  $app.innerHTML = topbar('#/') + `<div class="container">
    <div class="grid grid-3 mb">
      <div class="stat"><div class="num">${d.courses.length}</div><div class="lbl">在管课程</div></div>
      <div class="stat"><div class="num" style="color:var(--green)">${d.issued}</div><div class="lbl">累计颁发证书</div></div>
      <div class="stat"><div class="num" style="color:var(${d.pendingMakeups.length ? 'amber' : 'gray'})">${d.pendingMakeups.length}</div><div class="lbl">待处理补签申请</div></div>
    </div>
    ${d.pendingMakeups.length ? `<div class="card"><h2>⏳ 待审批的补签申请</h2>
      <table><thead><tr><th>学员</th><th>课程 / 课次</th><th>原因</th><th>申请时间</th><th></th></tr></thead>
      <tbody>${d.pendingMakeups.map(m => `<tr>
        <td><b>${esc(m.student_name)}</b></td>
        <td>${esc(m.course_title)}<br><span class="muted">${esc(m.session_title)}</span></td>
        <td style="max-width:280px">${esc(m.reason)}</td>
        <td class="muted">${fmtDT(m.created_at)}</td>
        <td><a class="btn btn-sm btn-primary" href="#/makeups">去处理</a></td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="card"><div class="flex-between mb"><h2 style="margin:0">课程列表</h2>
      <a class="btn btn-primary btn-sm" href="#/courses/new">+ 新建课程</a></div>
      ${d.courses.length ? `<table><thead><tr><th>课程</th><th>学员</th><th>课次</th><th>出勤门槛</th><th>及格线</th><th></th></tr></thead>
      <tbody>${d.courses.map(c => `<tr>
        <td><b>${esc(c.title)}</b><br><span class="muted">${esc(c.description.slice(0, 40))}</span></td>
        <td>${c.student_count}</td><td>${c.session_count}</td>
        <td>${pct(c.min_attendance_ratio)}%</td><td>${c.pass_score} 分</td>
        <td><a class="btn btn-sm" href="#/courses/${c.id}">管理</a></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">还没有课程，点击右上角新建</div>'}
    </div></div>`;
}

/* ---------- 新建课程 ---------- */
function orgNewCourse() {
  $app.innerHTML = topbar('#/courses/new') + `<div class="container"><div class="card" style="max-width:640px;margin:0 auto">
    <h2>新建课程</h2>
    <form id="newCourseForm">
      <label class="fld"><span>课程名称 *</span><input name="title" required placeholder="如：消防安全专项培训"></label>
      <label class="fld"><span>课程介绍</span><textarea name="description" rows="3" placeholder="培训对象、内容与学时安排"></textarea></label>
      <div class="row">
        <label class="fld"><span>最低出勤率（迟到按半次计）</span>
          <input name="minAttendanceRatio" type="number" min="1" max="100" value="80"> </label>
        <label class="fld"><span>测验及格线（分）</span>
          <input name="passScore" type="number" min="1" max="100" value="60"></label>
      </div>
      <div class="pill-actions mt">
        <button class="btn btn-primary">创建并进入管理</button>
        <a class="btn" href="#/">取消</a>
      </div>
    </form></div></div>`;
  document.getElementById('newCourseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const c = await api('POST', '/organizer/courses', {
        title: f.get('title'), description: f.get('description'),
        minAttendanceRatio: Number(f.get('minAttendanceRatio')) / 100,
        passScore: Number(f.get('passScore')),
      });
      toast('课程已创建');
      location.hash = '#/courses/' + c.id;
    } catch (err) { toast(err.message, true); }
  });
}

/* ---------- 课程详情（多 tab） ---------- */
async function orgCourseDetail(id, tab) {
  $app.innerHTML = topbar('#/') + `<div class="container"><div class="empty">加载中…</div></div>`;
  let d;
  try { d = await api('GET', '/organizer/courses/' + id); }
  catch (e) { $app.innerHTML = topbar('#/') + `<div class="container"><div class="card empty">${esc(e.message)}</div></div>`; return; }
  const c = d.course;
  const tabs = [['', '课次与签到码'], ['roster', '学员与结业'], ['quiz', '结业测验'], ['template', '证书样式'], ['certs', '证书记录'], ['audit', '课程日志']];
  const cur = tab || '';
  $app.innerHTML = topbar('#/') + `<div class="container">
    <div class="card">
      <div class="flex-between">
        <div><h2 style="margin-bottom:4px">${esc(c.title)} ${badge(c.status === 'active' ? 'valid' : 'neutral', c.status === 'active' ? '进行中' : '已关闭')}</h2>
        <div class="muted">出勤门槛 ${pct(c.min_attendance_ratio)}% ｜ 测验及格线 ${c.pass_score} 分</div></div>
        <a class="btn btn-sm" href="#/">← 返回</a>
      </div>
    </div>
    <div class="section-tabs">${tabs.map(([k, t]) =>
      `<button class="${cur === k ? 'active' : ''}" onclick="location.hash='#/courses/${id}${k ? '/' + k : ''}'">${t}</button>`).join('')}
    </div>
    <div id="tabBody"></div></div>`;
  const body = document.getElementById('tabBody');
  if (cur === '' ) body.innerHTML = sessionsTab(d);
  if (cur === 'roster') body.innerHTML = rosterTab(d);
  if (cur === 'quiz') body.innerHTML = quizTab(d);
  if (cur === 'template') body.innerHTML = templateTab(d);
  if (cur === 'certs') { body.innerHTML = '<div class="empty">加载中…</div>'; renderCertsTab(id, body); }
  if (cur === 'audit') { body.innerHTML = '<div class="empty">加载中…</div>'; renderAuditTab(id, body); }
  bindCourseTab(id, cur, d, body);
}

function sessionsTab(d) {
  const c = d.course;
  return `<div class="card">
    <h2>➕ 新增课次</h2>
    <form id="sessionForm">
      <div class="row">
        <label class="fld" style="flex:2"><span>课次名称 *</span><input name="title" required placeholder="如：第3讲 应急救护"></label>
        <label class="fld"><span>开始时间 *</span><input name="startAt" type="datetime-local" required></label>
        <label class="fld"><span>时长(分)</span><input name="durationMin" type="number" value="90"></label>
      </div>
      <div class="row">
        <label class="fld"><span>提前开放(分)</span><input name="openBeforeMin" type="number" value="30"></label>
        <label class="fld"><span>迟到宽限(分)</span><input name="lateGraceMin" type="number" value="10"></label>
        <label class="fld"><span>延后关闭(分)</span><input name="closeAfterMin" type="number" value="60"></label>
      </div>
      <button class="btn btn-primary">创建课次并生成签到码</button>
    </form>
  </div>
  <div class="card"><h2>课次列表（${d.sessions.length}）</h2>
    ${d.sessions.length ? `<table><thead><tr><th>课次</th><th>开始时间</th><th>窗口状态</th><th>当前签到码</th><th>操作</th></tr></thead>
    <tbody>${d.sessions.map(s => `<tr>
      <td><b>${esc(s.title)}</b><br><span class="muted">${s.duration_min}分钟 · 宽限${s.late_grace_min}分钟</span></td>
      <td>${fmtDT(s.start_at)}</td>
      <td>${s.state === 'open' ? badge('pending', '签到开放中') : s.state === 'upcoming' ? badge('neutral', '未开放') : badge('invalidated', '已结束')}</td>
      <td>${s.code ? `<code style="font-size:15px;font-weight:700;letter-spacing:3px">${esc(s.code.code)}</code>` : '—'}</td>
      <td class="pill-actions">
        <button class="btn btn-sm" onclick="showQR(${s.id})">二维码</button>
        <button class="btn btn-sm" onclick="rotateCode(${s.id})">换码</button>
        <button class="btn btn-sm" onclick="showAttendance(${s.id})">考勤明细</button>
      </td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">尚未创建课次</div>'}
  </div>`;
}

function rosterTab(d) {
  const c = d.course;
  return `<div class="card">
    <div class="flex-between mb"><h2 style="margin:0">报名管理</h2></div>
    <form id="enrollForm" class="row">
      <select name="studentId" style="flex:2"><option value="">选择学员加入课程…</option></select>
      <button class="btn btn-primary" style="flex:0 0 auto">报名</button>
    </form>
  </div>
  <div class="card"><h2>花名册与结业资格（${d.roster.length} 人）</h2>
    ${d.roster.length ? `<table><thead><tr><th>学员</th><th>出勤</th><th>测验最高</th><th>结业资格</th><th>证书</th><th>操作</th></tr></thead>
    <tbody>${d.roster.map(r => `<tr>
      <td><b>${esc(r.name)}</b><br><span class="muted">${esc(r.phone)}</span></td>
      <td style="min-width:150px">
        <div class="flex-between"><span class="muted">${pct(r.attendance.ratio)}%</span>
        <span class="muted" style="font-size:11px">正${r.attendance.counts.present} 迟${r.attendance.counts.late} 缺${r.attendance.counts.absent} 补${r.attendance.counts.makeup}</span></div>
        <div class="progress"><i class="${attBarClass(r.attendance.ratio)}" style="width:${pct(r.attendance.ratio)}%"></i></div></td>
      <td>${r.quiz.best == null ? '<span class="muted">未作答</span>'
        : `<b>${r.quiz.best}</b> 分 ${r.quiz.passed ? badge('valid', '过线') : badge('rejected', '未过')}`}</td>
      <td>${r.eligible ? badge('valid', '达标可发证') : `<span class="muted" style="font-size:12px">${esc(r.ineligibleReason)}</span>`}</td>
      <td>${r.validCert ? badge('valid', '持有效证') : badge('neutral', '无有效证')}</td>
      <td class="pill-actions">
        <button class="btn btn-sm ${r.eligible && !r.validCert ? 'btn-primary' : ''}" ${r.eligible && !r.validCert ? '' : 'disabled'}
          onclick="issueOne(${c.id},${r.id})">发证</button>
      </td></tr>`).join('')}</tbody></table>
    <div class="mt">
      <button class="btn" onclick="issueEligibleBatch(${c.id})">批量给全部达标且无证学员发证</button>
    </div>` : '<div class="empty">还没有学员报名</div>'}
  </div>`;
}

function quizTab(d) {
  const q = d.quiz;
  const questions = q ? q.questions : [];
  window.__quizSeed = questions.map(x => ({
    text: x.text, options: JSON.parse(x.options_json), correctIndex: x.correct_index,
  }));
  return `<div class="card"><h2>结业测验</h2>
    <p class="muted mb">及格线 <b>${d.course.pass_score} 分</b>，学员可多次作答，系统取最高分判定是否过线。保存后学员端即可作答。</p>
    <form id="quizForm">
      <label class="fld"><span>测验标题</span><input name="title" value="${esc(q ? q.title : '结业测验')}"></label>
      <div id="qList"></div>
      <div class="pill-actions">
        <button type="button" class="btn" onclick="addQuestion()">+ 添加题目</button>
        <button class="btn btn-primary">保存测验</button>
      </div>
    </form></div>`;
}

function templateTab(d) {
  const t = d.template;
  return `<div class="card" style="max-width:680px;margin:0 auto"><h2>证书样式</h2>
    <form id="tplForm">
      <div class="row">
        <label class="fld"><span>发证机构 *</span><input name="orgName" value="${esc(t?.org_name || '')}" placeholder="如：华晟职业培训中心"></label>
        <label class="fld"><span>证书标题 *</span><input name="title" value="${esc(t?.title || '结业证书')}"></label>
      </div>
      <div class="row">
        <label class="fld" style="flex:2"><span>英文副标题</span><input name="subtitle" value="${esc(t?.subtitle || 'CERTIFICATE OF COMPLETION')}"></label>
        <label class="fld"><span>主题色</span><input name="accentColor" type="color" value="${esc(t?.accent_color || '#1d4ed8')}"></label>
      </div>
      <div class="row">
        <label class="fld"><span>签发人 *</span>
          <input name="signerName" value="${esc(t?.signer_name || '')}" placeholder="如：刘建华"></label>
        <label class="fld"><span>签发人头衔</span><input name="signerTitle" value="${esc(t?.signer_title || '')}" placeholder="如：培训中心主任"></label>
      </div>
      <button class="btn btn-primary">保存样式</button>
    </form></div>`;
}

window.__quizSeed = null;
function bindCourseTab(courseId, tab, d, body) {
  if (tab === '') {
    const defaultStart = new Date(Date.now() + 7 * 86400000 - new Date().getTimezoneOffset() * 60000);
    document.querySelector('input[name=startAt]').value = toLocalInput(defaultStart).slice(0, 16);
    document.getElementById('sessionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('POST', `/organizer/courses/${courseId}/sessions`, {
          title: f.get('title'), startAt: new Date(f.get('startAt')).toISOString(),
          durationMin: Number(f.get('durationMin')), lateGraceMin: Number(f.get('lateGraceMin')),
          openBeforeMin: Number(f.get('openBeforeMin')), closeAfterMin: Number(f.get('closeAfterMin')),
        });
        toast('课次已创建，签到码已生成');
        orgCourseDetail(courseId, '');
      } catch (err) { toast(err.message, true); }
    });
  }
  if (tab === 'roster') {
    api('GET', '/organizer/students').then((students) => {
      const sel = body.querySelector('select[name=studentId]');
      if (!sel) return;
      const enrolledIds = new Set(d.roster.map(r => r.id));
      sel.innerHTML = '<option value="">选择学员加入课程…</option>' +
        students.filter(s => !enrolledIds.has(s.id))
          .map(s => `<option value="${s.id}">${esc(s.name)}（${esc(s.phone)}）</option>`).join('');
    }).catch(() => {});
    document.getElementById('enrollForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const sid = new FormData(e.target).get('studentId');
      if (!sid) return toast('请先选择学员', true);
      try { await api('POST', `/organizer/courses/${courseId}/enroll`, { studentId: Number(sid) });
        toast('报名成功'); orgCourseDetail(courseId, 'roster');
      } catch (err) { toast(err.message, true); }
    });
  }
  if (tab === 'quiz') {
    const seed = window.__quizSeed || [];
    const list = document.getElementById('qList');
    window.addQuestion = (data) => {
      const idx = list.children.length;
      const box = document.createElement('div');
      box.className = 'question-box';
      box.innerHTML = `
        <div class="flex-between"><b>题目 ${idx + 1}</b>
          <button type="button" class="btn btn-sm btn-danger" onclick="this.closest('.question-box').remove();renumberQs()">删除</button></div>
        <label class="fld mt"><span>题干</span><input class="q-text" value="${esc(data?.text || '')}" placeholder="题目内容"></label>
        <div class="opts">${(data?.options || ['', '']).map((o, oi) => optRow(o, oi === (data?.correctIndex ?? 0))).join('')}</div>
        <button type="button" class="btn btn-sm mt" onclick="addOption(this)">+ 选项</button>`;
      list.appendChild(box);
      renumberQs();
    };
    window.addOption = (btn) => {
      const opts = btn.previousElementSibling;
      const wrap = document.createElement('div');
      wrap.innerHTML = optRow('', false);
      const row = wrap.firstElementChild;
      opts.appendChild(row);
      renumberQs();
    };
    window.renumberQs = () => {
      [...list.children].forEach((box, i) => {
        box.querySelector('b').textContent = '题目 ' + (i + 1);
        const radios = box.querySelectorAll('input[type=radio]');
        radios.forEach(r => r.name = 'correct_' + i);
      });
    };
    function optRow(value, checked) {
      return `<label class="opt"><input type="radio" name="correct" ${checked ? 'checked' : ''}>
        <input type="text" class="opt-text" style="border:none;background:transparent;flex:1" value="${esc(value)}" placeholder="选项内容"></label>`;
    }
    window.__addOption = window.addOption;
    seed.forEach(s => window.addQuestion(s));
    if (!seed.length) { window.addQuestion(); window.addQuestion(); }
    document.getElementById('quizForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = e.target.title.value.trim();
      const questions = [...list.children].map((box) => {
        const optEls = [...box.querySelectorAll('.opt')];
        const correctIndex = optEls.findIndex(o => o.querySelector('input[type=radio]').checked);
        return {
          text: box.querySelector('.q-text').value.trim(),
          options: optEls.map(o => o.querySelector('.opt-text').value.trim()),
          correctIndex,
        };
      });
      if (!title) return toast('请填写测验标题', true);
      for (const [i, q] of questions.entries()) {
        if (!q.text) return toast(`第 ${i + 1} 题题干为空`, true);
        if (q.options.some(o => !o)) return toast(`第 ${i + 1} 题存在空选项`, true);
        if (q.correctIndex < 0) return toast(`第 ${i + 1} 题未勾选正确答案`, true);
      }
      try {
        await api('PUT', `/organizer/courses/${courseId}/quiz`, { title, questions });
        toast('测验已保存'); orgCourseDetail(courseId, 'quiz');
      } catch (err) { toast(err.message, true); }
    });
  }
  if (tab === 'template') {
    document.getElementById('tplForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('PUT', `/organizer/courses/${courseId}/template`, {
          orgName: f.get('orgName'), title: f.get('title'), subtitle: f.get('subtitle'),
          accentColor: f.get('accentColor'), signerName: f.get('signerName'),
          signerTitle: f.get('signerTitle'),
        });
        toast('证书样式已保存'); orgCourseDetail(courseId, 'template');
      } catch (err) { toast(err.message, true); }
    });
  }
}

/* ---------- 弹窗：二维码 / 考勤明细 ---------- */
window.showQR = async (sid) => {
  const m = modal('<div class="text-center">生成二维码中…</div>');
  try {
    const d = await api('GET', `/organizer/sessions/${sid}/qr`);
    m.querySelector('.modal').innerHTML = `
      <h3 class="text-center">课次签到码</h3>
      <div class="text-center"><div class="qr-box"><img src="${d.qrDataUrl}" alt="签到二维码"></div></div>
      <div class="text-center mt"><div class="muted">学员 App 扫码或手动输入</div>
      <div class="code-big mt">${esc(d.code)}</div></div>
      <div class="muted text-center mt" style="font-size:12px">二维码内嵌一次性活动码，点击“换码”后旧码立即失效</div>
      <div class="text-center mt"><button class="btn" onclick="closeModal()">关 闭</button></div>`;
  } catch (e) { closeModal(); toast(e.message, true); }
};
window.closeModal = closeModal;

window.rotateCode = async (sid) => {
  if (!confirm('确认轮换签到码？旧码立即失效。')) return;
  try {
    const d = await api('POST', `/organizer/sessions/${sid}/rotate-code`);
    toast('新签到码：' + d.code);
    const hash = location.hash.split('/');
    orgCourseDetail(Number(hash[2]), hash[3] || '');
  } catch (e) { toast(e.message, true); }
};

window.showAttendance = async (sid) => {
  const m = modal('<div class="text-center">加载中…</div>');
  try {
    const d = await api('GET', `/organizer/sessions/${sid}/attendance`);
    m.querySelector('.modal').innerHTML = `
      <h3>${esc(d.session.title)} · 考勤明细</h3>
      <table><thead><tr><th>学员</th><th>状态</th><th>签到时间</th><th>备注</th></tr></thead>
      <tbody>${d.rows.map(r => `<tr>
        <td><b>${esc(r.name)}</b></td>
        <td>${r.status ? badge(r.status) : badge('neutral', '未签到')}</td>
        <td class="muted">${r.signed_at ? fmtDT(r.signed_at) : '—'}</td>
        <td class="muted" style="max-width:220px">${esc(r.note || '')}</td></tr>`).join('')}
      </tbody></table>
      <div class="text-center mt"><button class="btn" onclick="closeModal()">关 闭</button></div>`;
  } catch (e) { closeModal(); toast(e.message, true); }
};

/* ---------- 发证 ---------- */
window.issueOne = async (courseId, studentId) => {
  try {
    const r = await api('POST', `/organizer/courses/${courseId}/certificates/issue`, { studentIds: [studentId] });
    if (r.issued.length) toast('证书已颁发：' + r.issued[0].certNo);
    else toast(r.skipped[0]?.reason || '发证失败', true);
    orgCourseDetail(courseId, 'roster');
  } catch (e) { toast(e.message, true); }
};

window.issueEligibleBatch = async (courseId) => {
  const d = await api('GET', '/organizer/courses/' + courseId);
  const ids = d.roster.filter(r => r.eligible && !r.validCert).map(r => r.id);
  if (!ids.length) return toast('当前没有“达标且无证”的学员', true);
  if (!confirm(`将为 ${ids.length} 名达标学员批量发证，确认？`)) return;
  try {
    const r = await api('POST', `/organizer/courses/${courseId}/certificates/issue`, { studentIds: ids });
    toast(`成功颁发 ${r.issued.length} 张${r.skipped.length ? '，跳过 ' + r.skipped.length + ' 人' : ''}`);
    orgCourseDetail(courseId, 'roster');
  } catch (e) { toast(e.message, true); }
};

/* ---------- 证书记录 ---------- */
async function renderCertsTab(courseId, body) {
  try {
    const rows = await api('GET', `/organizer/courses/${courseId}/certificates`);
    if (!rows.length) { body.innerHTML = '<div class="card"><div class="empty"><div class="icon">🏅</div>暂无证书，请先在“学员与结业”页为达标学员发证</div></div>'; return; }
    body.innerHTML = `<div class="card"><h2>证书台账（${rows.length}）</h2>
      <p class="muted mb">失效证书仍完整保留，点击“换发链”可查看每一张证书的作废原因与补发去向。</p>
      <table><thead><tr><th>证书编号</th><th>学员</th><th>类型</th><th>状态</th><th>签发 / 失效时间</th><th>作废原因</th><th>操作</th></tr></thead>
      <tbody>${rows.map(c => `<tr>
        <td><a href="#/verify/${encodeURIComponent(c.cert_no)}" target="_blank"><code>${esc(c.cert_no)}</code></a></td>
        <td><b>${esc(c.student_name)}</b></td>
        <td>${badge(c.issue_reason)}${c.supersedes_id ? '<div class="muted" style="font-size:11px">替换 #'+c.supersedes_id+'</div>' : ''}</td>
        <td>${badge(c.status)}</td>
        <td class="muted" style="font-size:12px">${fmtDT(c.created_at)}${c.invalidated_at ? '<br>' + fmtDT(c.invalidated_at) : ''}</td>
        <td style="max-width:220px" class="muted" style="font-size:12px">${esc(c.invalidate_reason || '')}</td>
        <td class="pill-actions">
          <a class="btn btn-sm" href="#/verify/${encodeURIComponent(c.cert_no)}" target="_blank">查验</a>
          <button class="btn btn-sm" onclick="showChain(${c.id}, ${JSON.stringify(c.cert_no)})">换发链</button>
          ${c.status === 'valid'
            ? `<button class="btn btn-sm btn-danger" onclick="invalidateCert(${c.id})">作废</button>
               <button class="btn btn-sm" onclick="reissueCert(${c.id})">补发/换发</button>`
            : `<button class="btn btn-sm" onclick="reissueCert(${c.id})">补 发</button>`}
        </td></tr>`).join('')}</tbody></table></div>`;
  } catch (e) { body.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}

window.showChain = async (certId, certNo) => {
  const m = modal('<div class="text-center">加载中…</div>');
  try {
    const d = await api('GET', '/verify/' + encodeURIComponent(certNo.trim()));
    m.querySelector('.modal').innerHTML = `
      <h3>证书换发链</h3>
      <ul class="timeline">${d.chain.map((x, i) => `
        <li class="${x.status === 'invalidated' ? 'invalid' : ''}">
          <div class="flex-between"><b>${esc(x.certNo)}</b>
            <span>${badge(x.status)} ${badge(x.issueReason)}</span></div>
          <div class="muted" style="font-size:12px">持证人：${esc(x.studentName)} ｜ 签发：${fmtDT(x.createdAt)}
            ${x.invalidatedAt ? ' ｜ 失效：' + fmtDT(x.invalidatedAt) : ''}</div>
          ${x.invalidateReason ? `<div style="font-size:13px;margin-top:3px">作废原因：<b style="color:var(--red)">${esc(x.invalidateReason)}</b></div>` : ''}
          ${x.events.map(ev => `<div class="muted" style="font-size:12px">· ${AUDIT_ACTION_CN[ev.action] || ev.action}
            ${ev.actor_label ? '（' + esc(ev.actor_label) + '）' : ''}</div>`).join('')}
          ${i < d.chain.length - 1 ? '<div class="muted" style="font-size:12px">⬇ 补发为</div>' : ''}
        </li>`).join('')}</ul>
      <div class="text-center mt"><button class="btn" onclick="closeModal()">关 闭</button></div>`;
  } catch (e) { closeModal(); toast(e.message, true); }
};

window.invalidateCert = (certId) => {
  const m = modal(`<h3>作废证书</h3>
    <p class="muted mb">作废后该证书在公开查验页将显示“已失效”及原因。可后续补发新证。</p>
    <label class="fld"><span>作废原因 *（将永久记录并对查验者可见）</span>
      <select id="invReasonPreset" class="mb">
        <option value="">选择或在下方自定义…</option>
        <option>学员信息（姓名/证件号）有误，作废重发</option>
        <option>证书遗失，经公示后作废</option>
        <option>复查发现考勤/测验作弊，撤销证书</option>
        <option>不符合结业条件，误发撤销</option>
      </select>
      <textarea id="invReason" rows="3" placeholder="请填写具体原因"></textarea></label>
    <div class="pill-actions"><button class="btn btn-danger" id="invOk">确认作废</button>
    <button class="btn" onclick="closeModal()">取消</button></div>`);
  m.querySelector('#invReasonPreset').addEventListener('change', (e) => {
    if (e.target.value) m.querySelector('#invReason').value = e.target.value;
  });
  m.querySelector('#invOk').addEventListener('click', async () => {
    const reason = m.querySelector('#invReason').value.trim();
    if (reason.length < 4) return toast('请填写不少于 4 个字的作废原因', true);
    try {
      await api('POST', `/organizer/certificates/${certId}/invalidate`, { reason });
      closeModal(); toast('证书已作废');
      const h = location.hash.split('/');
      orgCourseDetail(Number(h[2]), 'certs');
    } catch (e) { toast(e.message, true); }
  });
};

window.reissueCert = (certId) => {
  const m = modal(`<h3>补发 / 换发证书</h3>
    <p class="muted mb">将生成新的有效证书编号，并与原证书建立换发链；
    若原证书仍有效，会先按原因自动作废再补发。</p>
    <label class="fld"><span>补发原因 *</span>
      <select id="rePreset" class="mb">
        <option value="">选择常见原因…</option>
        <option>证书信息更正后补发</option>
        <option>原证书遗失补发</option>
        <option>原证书损毁补发</option>
      </select>
      <textarea id="reReason" rows="3" placeholder="请填写补发原因"></textarea></label>
    <div class="pill-actions"><button class="btn btn-primary" id="reOk">确认补发</button>
    <button class="btn" onclick="closeModal()">取消</button></div>`);
  m.querySelector('#rePreset').addEventListener('change', (e) => {
    if (e.target.value) m.querySelector('#reReason').value = e.target.value;
  });
  m.querySelector('#reOk').addEventListener('click', async () => {
    const reason = m.querySelector('#reReason').value.trim();
    if (reason.length < 4) return toast('请填写不少于 4 个字的补发原因', true);
    try {
      const cert = await api('POST', `/organizer/certificates/${certId}/reissue`, { reason });
      closeModal(); toast('补发成功，新证号：' + cert.cert_no);
      const h = location.hash.split('/');
      orgCourseDetail(Number(h[2]), 'certs');
    } catch (e) { toast(e.message, true); }
  });
};

/* ---------- 补签审批 ---------- */
async function orgMakeups() {
  $app.innerHTML = topbar('#/makeups') + `<div class="container"><div class="card">
    <h2>补签审批</h2><div id="mkBody" class="empty">加载中…</div></div></div>`;
  try {
    const rows = await api('GET', '/organizer/makeup-requests');
    const body = document.getElementById('mkBody');
    if (!rows.length) { body.className = 'empty'; body.innerHTML = '<div class="icon">✅</div>暂无补签申请'; return; }
    body.className = '';
    body.innerHTML = `<table><thead><tr><th>状态</th><th>学员</th><th>课程 / 课次</th><th>申请原因</th><th>审核备注 / 时间</th><th>操作</th></tr></thead>
    <tbody>${rows.map(m => `<tr>
      <td>${badge(m.status)}</td>
      <td><b>${esc(m.student_name)}</b></td>
      <td>${esc(m.course_title)}<br><span class="muted">${esc(m.session_title)} · ${fmtDT(m.start_at)}</span></td>
      <td style="max-width:260px">${esc(m.reason)}<div class="muted" style="font-size:12px">申请于 ${fmtDT(m.created_at)}</div></td>
      <td style="max-width:200px" class="muted">${esc(m.review_note || '')}${m.reviewed_at ? '<br>' + fmtDT(m.reviewed_at) : ''}</td>
      <td class="pill-actions">
        ${m.status === 'pending'
          ? `<button class="btn btn-sm btn-primary" onclick="reviewMakeup(${m.id},true)">批准补签</button>
             <button class="btn btn-sm btn-danger" onclick="reviewMakeup(${m.id},false)">驳回</button>`
          : `<a class="btn btn-sm" href="#/courses/${m.course_id}">查看课程</a>`}
      </td></tr>`).join('')}</tbody></table>`;
  } catch (e) { document.getElementById('mkBody').textContent = e.message; }
}

window.reviewMakeup = (id, approve) => {
  const m = modal(`<h3>${approve ? '批准补签' : '驳回补签申请'}</h3>
    <label class="fld"><span>审核备注</span><textarea id="rvNote" rows="3"
      placeholder="${approve ? '如：已核验证明材料，情况属实，准予补签' : '如：材料不足，不予补签'}"></textarea></label>
    <div class="pill-actions"><button class="btn ${approve ? 'btn-primary' : 'btn-danger'}" id="rvOk">确认</button>
    <button class="btn" onclick="closeModal()">取消</button></div>`);
  m.querySelector('#rvOk').addEventListener('click', async () => {
    try {
      await api('POST', `/organizer/makeup-requests/${id}/${approve ? 'approve' : 'reject'}`,
        { reviewNote: m.querySelector('#rvNote').value.trim() });
      closeModal(); toast(approve ? '已批准，考勤改为“补签”' : '已驳回'); orgMakeups();
    } catch (e) { toast(e.message, true); }
  });
};

/* ---------- 审计 ---------- */
async function orgAudit(courseId = null, body) {
  const standalone = !body;
  if (standalone) $app.innerHTML = topbar('#/audit') + `<div class="container"><div class="card">
    <h2>全课程操作审计</h2><div id="auBody" class="empty">加载中…</div></div></div>`;
  const target = body || document.getElementById('auBody');
  try {
    const rows = await api('GET', '/organizer/audit' + (courseId ? '?courseId=' + courseId : ''));
    target.className = '';
    target.innerHTML = rows.length ? `<table><thead><tr><th>时间</th><th>操作</th><th>操作人</th><th>对象</th><th>详情</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="muted" style="white-space:nowrap">${fmtDT(r.created_at)}</td>
        <td><b>${AUDIT_ACTION_CN[r.action] || r.action}</b></td>
        <td>${esc(r.actor_label)}</td>
        <td class="muted">${esc(r.entity_type)}${r.entity_id ? ' #' + r.entity_id : ''}</td>
        <td class="muted" style="max-width:340px;font-size:12px">${esc(formatDetail(r.action, r.detail_json))}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">暂无审计记录</div>';
  } catch (e) { target.textContent = e.message; }
}
function renderAuditTab(courseId, body) { orgAudit(courseId, body); }

function formatDetail(action, json) {
  try {
    const d = JSON.parse(json);
    if (action === 'cert_invalidated') return `${d.certNo || ''} ${d.reason || ''}`;
    if (action === 'cert_reissued') return `${d.certNo || ''} 替换 #${d.supersedesId || ''} ${d.reason || ''}`;
    if (action === 'cert_issued') return d.certNo || JSON.stringify(d);
    if (action === 'checkin') return `${d.status} via ${d.code || ''}`;
    if (action === 'quiz_submitted') return `${d.score}分 ${d.passed ? '通过' : '未通过'}`;
    if (action === 'code_rotated') return '新码 ' + (d.code || '');
    return Object.keys(d).length ? JSON.stringify(d) : '';
  } catch (e) { return ''; }
}

/* ================= 学员端 ================= */
async function renderStudent(hash) {
  if (hash === '#/checkin') return stuCheckin();
  if (hash === '#/certs') return stuCerts();
  if (hash === '#/explore') return stuExplore();
  const cm = hash.match(/^#\/courses\/(\d+)(?:\/(quiz|detail))?$/);
  if (cm) return cm[2] === 'quiz' ? stuQuiz(Number(cm[1])) : stuCourseDetail(Number(cm[1]));
  return stuHome();
}

async function stuHome() {
  $app.innerHTML = topbar('#/') + '<div class="container"><div class="empty">加载中…</div></div>';
  let courses;
  try { courses = await api('GET', '/student/my/courses'); }
  catch (e) { $app.innerHTML = topbar('#/') + `<div class="container"><div class="card empty">${esc(e.message)}</div></div>`; return; }
  $app.innerHTML = topbar('#/') + `<div class="container">
    <div class="card"><div class="flex-between"><h2 style="margin:0">我的培训（${courses.length}）</h2>
      <a class="btn btn-sm" href="#/explore">去课程广场报名 →</a></div></div>
    ${courses.length ? courses.map(c => courseCard(c)).join('')
      : '<div class="card"><div class="empty"><div class="icon">📚</div>你还没有报名任何课程<br><a class="btn btn-primary mt" href="#/explore">浏览课程广场</a></div></div>'}
  </div>`;
}

function sessionAction(s) {
  const mk = s.makeupRequest;
  // 尚无考勤记录
  if (!s.status) {
    if (s.state === 'open') return badge('pending', '签到中，去签到');
    if (s.state !== 'closed') return badge('neutral', '未开始');
    if (!mk) return `<button class="btn btn-sm" onclick='requestMakeup(${s.id})'>申请补签</button>`;
    if (mk.status === 'pending') return badge('pending', '补签待审核');
    if (mk.status === 'rejected')
      return badge('rejected', '补签已驳回') + ` <button class="btn btn-sm" onclick='requestMakeup(${s.id})'>补充材料重申</button>`;
    return badge('approved', '补签已批准');
  }
  // 已有考勤状态
  let html = badge(s.status);
  if (mk) html += ' ' + badge(mk.status, '补签' + STATUS_CN[mk.status]);
  if (s.status === 'absent' && (!mk || mk.status === 'rejected'))
    html += ` <button class="btn btn-sm" onclick='requestMakeup(${s.id})'>${mk ? '补充材料重申' : '申请补签'}</button>`;
  return html;
}

function courseCard(c) {
  const sessRows = c.sessions.map(s => {
    const actions = sessionAction(s);
    return `<tr>
      <td>${esc(s.title)}<br><span class="muted" style="font-size:12px">${fmtDT(s.start_at)}</span></td>
      <td>${s.status ? badge(s.status) : badge('neutral', s.state === 'upcoming' ? '未开始' : s.state === 'open' ? '待签到' : '缺课')}</td>
      <td class="muted" style="font-size:12px">${s.signed_at ? fmtDT(s.signed_at) : '—'}</td>
      <td class="pill-actions" style="justify-content:flex-end">${actions}</td></tr>`;
  }).join('');
  return `<div class="card">
    <div class="flex-between">
      <div><h2 style="margin-bottom:2px">${esc(c.title)}</h2>
      <div class="muted">主办方：${esc(c.organizer_name)} ｜ 结业要求：出勤≥${pct(c.min_attendance_ratio)}% 且 测验≥${c.pass_score}分</div></div>
      ${c.validCert ? badge('valid', '已获有效证书') : c.eligible ? badge('pending', '已达标待发证') : badge('neutral', '学习中')}
    </div>
    <div class="grid grid-2 mt">
      <div>
        <div class="flex-between"><b>出勤率</b><span>${pct(c.attendance.ratio)}% ${c.attendance.passedAttendance ? '✅' : '❌'}</span></div>
        <div class="progress mt"><i class="${attBarClass(c.attendance.ratio)}" style="width:${pct(c.attendance.ratio)}%"></i></div>
        <div class="muted mt" style="font-size:12px">正常 ${c.attendance.counts.present} ｜ 迟到 ${c.attendance.counts.late}（按半次计）
          ｜ 缺课 ${c.attendance.counts.absent} ｜ 补签 ${c.attendance.counts.makeup}</div>
      </div>
      <div>
        <div class="flex-between"><b>结业测验</b>
          <span>${c.quiz.best == null ? '未作答' : `最高 ${c.quiz.best} 分 ${c.quiz.passed ? '✅' : '❌'}（${c.quiz.attempts} 次）`}</span></div>
        <div class="mt pill-actions"><a class="btn btn-sm btn-primary" href="#/courses/${c.id}/quiz">参加 / 查看测验</a></div>
      </div>
    </div>
    ${!c.eligible ? `<div class="muted mt" style="font-size:13px">距离结业：${esc(c.ineligibleReason)}</div>` : ''}
    ${c.validCert ? `<div class="mt" style="border-top:1px solid var(--line);padding-top:12px">
      ${badge('valid', '有效证书')} <a href="#/verify/${encodeURIComponent(c.validCert.cert_no)}"><code>${esc(c.validCert.cert_no)}</code></a>
      <a class="btn btn-sm" href="#/certs">查看我的证书</a></div>` : ''}
    <details class="mt"><summary class="muted" style="cursor:pointer">展开全部课次考勤（${c.sessions.length}）</summary>
      <table class="mt"><thead><tr><th>课次</th><th>状态</th><th>签到时间</th><th style="text-align:right">操作</th></tr></thead>
      <tbody>${sessRows}</tbody></table></details>
  </div>`;
}

/* ---------- 扫码 / 输入码签到 ---------- */
function stuCheckin(prefill = '') {
  $app.innerHTML = topbar('#/checkin') + `<div class="container" style="max-width:520px">
    <div class="card text-center">
      <h2>扫码 / 输入签到码</h2>
      <div class="muted mb">向主办方索取课次二维码，或直接输入 6 位签到码</div>
      <form id="checkinForm">
        <input name="code" value="${esc(prefill)}" autocomplete="off" maxlength="8"
          style="text-align:center;font-size:26px;letter-spacing:10px;font-weight:800;text-transform:uppercase;height:64px"
          placeholder="ABC123">
        <button class="btn btn-primary mt" style="width:100%;padding:12px">签 到</button>
      </form>
      <div id="checkinResult" class="mt"></div>
    </div>
  </div>`;
  const input = document.querySelector('input[name=code]');
  input.focus(); input.select();
  document.getElementById('checkinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get('code');
    const out = document.getElementById('checkinResult');
    try {
      const r = await api('POST', '/student/checkin', { code });
      out.innerHTML = `<div class="card" style="margin:0;background:var(--green-soft);border-color:#86efac">
        <div style="font-size:30px">✅</div><b>${esc(r.message)}</b>
        <div class="muted">${esc(r.sessionTitle)}</div></div>`;
    } catch (err) {
      out.innerHTML = `<div class="card" style="margin:0;background:var(--red-soft);border-color:#fca5a5">
        <div style="font-size:26px">⚠️</div><b>${esc(err.message)}</b></div>`;
    }
  });
}

/* 二维码载荷识别（真实摄像头扫码需要外部设备，这里支持粘贴/解析二维码内容） */
window.addEventListener('message', (e) => {});

window.requestMakeup = (sessionId) => {
  const m = modal(`<h3>申请补签</h3>
    <p class="muted mb">请如实填写缺课原因，提交后由主办方审核；批准后本次课次记为“补签”。</p>
    <label class="fld"><span>缺课原因 *（不少于 5 个字）</span>
      <textarea id="mkReason" rows="4" placeholder="如：当日突发高烧就医，可提供挂号记录"></textarea></label>
    <div class="pill-actions"><button class="btn btn-primary" id="mkOk">提交申请</button>
    <button class="btn" onclick="closeModal()">取消</button></div>`);
  m.querySelector('#mkOk').addEventListener('click', async () => {
    const reason = m.querySelector('#mkReason').value.trim();
    if (reason.length < 5) return toast('请填写不少于 5 个字的原因', true);
    try {
      await api('POST', `/student/sessions/${sessionId}/makeup`, { reason });
      closeModal(); toast('补签申请已提交，等待主办方审核'); stuHome();
    } catch (e) { toast(e.message, true); }
  });
};

/* ---------- 测验 ---------- */
async function stuQuiz(courseId) {
  $app.innerHTML = topbar('#/') + '<div class="container"><div class="empty">加载中…</div></div>';
  let q;
  try { q = await api('GET', `/student/courses/${courseId}/quiz`); }
  catch (e) { $app.innerHTML = topbar('#/') + `<div class="container"><div class="card">
    <div class="empty">${esc(e.message)}<div class="mt"><a class="btn" href="#/">返回我的课程</a></div></div></div></div>`; return; }
  $app.innerHTML = topbar('#/') + `<div class="container" style="max-width:760px">
    <div class="card"><a href="#/" class="muted">← 返回我的课程</a>
      <h2 class="mt">${esc(q.title)}</h2>
      <div class="muted mb">共 ${q.questions.length} 题 ｜ 及格线 ${q.passScore} 分 ｜ 可多次作答，取最高分</div>
      ${q.attempts.length ? `<div class="mb pill-actions">${q.attempts.map(a =>
        `<span class="badge ${a.score >= q.passScore ? 'b-valid' : 'b-rejected'}">${fmtDT(a.created_at).slice(5)} · ${a.score}分</span>`).join('')}</div>` : ''}
      <form id="quizTake">${q.questions.map((qu, i) => `
        <div class="question-box">
          <b>${i + 1}. ${esc(qu.text)}</b> <span class="muted">（${qu.score} 分）</span>
          <div class="opts">${qu.options.map((o, oi) => `
            <label class="opt"><input type="radio" name="q${qu.id}" value="${oi}"><span>${esc(o)}</span></label>`).join('')}
          </div>
        </div>`).join('')}
        <button class="btn btn-primary" type="submit">提交答卷</button>
      </form></div></div>`;
  document.getElementById('quizTake').addEventListener('submit', async (e) => {
    e.preventDefault();
    const answers = {};
    for (const qu of q.questions) {
      const v = new FormData(e.target).get('q' + qu.id);
      if (v == null) return toast('第 ' + (q.questions.indexOf(qu) + 1) + ' 题未作答', true);
      answers[qu.id] = Number(v);
    }
    try {
      const r = await api('POST', `/student/courses/${courseId}/quiz/submit`, { answers });
      const mm = modal(`<div class="text-center">
        <div style="font-size:44px">${r.pass ? '🎉' : '💪'}</div>
        <h3>本次得分：${r.score} 分 ${r.pass ? '，已达及格线！' : '，未达及格线'}</h3>
        <div class="muted mb">${q.questions.map((qu, i) => `${i + 1} ${r.details[i].ok ? '✓' : '✗'}`).join('　')}</div>
        <p class="muted">${r.pass ? '若出勤率也达标，即可获颁结业证书。' : '可重新作答，成绩取最高一次。'}</p>
        <div class="pill-actions" style="justify-content:center">
          <button class="btn" onclick="closeModal();stuQuiz(${courseId})">再做一次</button>
          <button class="btn btn-primary" onclick="closeModal();location.hash='#/'">返回课程</button></div>
      </div>`);
    } catch (err) { toast(err.message, true); }
  });
}

async function stuCourseDetail(courseId) { location.hash = '#/'; }

/* ---------- 我的证书 ---------- */
async function stuCerts() {
  $app.innerHTML = topbar('#/certs') + '<div class="container"><div class="empty">加载中…</div></div>';
  let rows;
  try { rows = await api('GET', '/student/my/certificates'); }
  catch (e) { $app.innerHTML = topbar('#/certs') + `<div class="container"><div class="card empty">${esc(e.message)}</div></div>`; return; }
  if (!rows.length) {
    $app.innerHTML = topbar('#/certs') + `<div class="container"><div class="card">
      <div class="empty"><div class="icon">🏅</div>还没有证书。完成全部课次签到并通过结业测验后，由主办方颁发。</div></div></div>`;
    return;
  }
  $app.innerHTML = topbar('#/certs') + `<div class="container">
    ${rows.map(c => `<div class="card">
      <div class="flex-between">
        <div><h2 style="margin:0">${esc(c.course_title)}</h2>
        <div class="muted">证书编号 <code>${esc(c.cert_no)}</code> ｜ 签发 ${fmtDT(c.created_at)}</div></div>
        <div class="pill-actions">
          ${badge(c.status)} ${badge(c.issue_reason)}
          <a class="btn btn-sm" target="_blank" href="#/verify/${encodeURIComponent(c.cert_no)}">查 验</a>
          <button class="btn btn-sm" onclick="printCert('${esc(c.cert_no)}')">打印</button>
        </div>
      </div>
      ${c.invalidate_reason ? `<div class="mt" style="background:var(--red-soft);border-radius:8px;padding:10px 12px;font-size:13px">
        失效原因：<b style="color:var(--red)">${esc(c.invalidate_reason)}</b></div>` : ''}
      ${c.chain.length > 1 ? `<details class="mt"><summary class="muted" style="cursor:pointer">该证书经历 ${c.chain.length} 次换发，查看完整链路</summary>
        <ul class="timeline mt">${c.chain.map(x => `<li class="${x.status === 'invalidated' ? 'invalid' : ''}">
          <div class="flex-between"><code>${esc(x.certNo)}</code> ${badge(x.status)} ${badge(x.issueReason)}</div>
          <div class="muted" style="font-size:12px">${fmtDT(x.createdAt)}${x.invalidateReason ? ' ｜ ' + esc(x.invalidateReason) : ''}</div>
        </li>`).join('')}</ul></details>` : ''}
    </div>`).join('')}
  </div>`;
}

window.printCert = (certNo) => {
  window.open('/#/verify/' + encodeURIComponent(certNo), '_blank');
};

/* ---------- 课程广场 ---------- */
async function stuExplore() {
  $app.innerHTML = topbar('#/explore') + '<div class="container"><div class="empty">加载中…</div></div>';
  let rows;
  try { rows = await api('GET', '/student/available-courses'); }
  catch (e) { $app.innerHTML = topbar('#/explore') + `<div class="container"><div class="card empty">${esc(e.message)}</div></div>`; return; }
  $app.innerHTML = topbar('#/explore') + `<div class="container"><div class="card"><h2>课程广场</h2>
    ${rows.length ? `<div class="grid">${rows.map(c => `<div style="border:1px solid var(--line);border-radius:10px;padding:16px">
      <div class="flex-between"><b>${esc(c.title)}</b>
        <button class="btn btn-sm btn-primary" onclick="selfEnroll(${c.id})">报名</button></div>
      <div class="muted mt">${esc(c.description)}</div>
      <div class="muted mt" style="font-size:12px">主办方：${esc(c.organizer_name)} ｜ 出勤≥${pct(c.min_attendance_ratio)}% ｜ 测验≥${c.pass_score}分</div>
    </div>`).join('')}</div>` : '<div class="empty">暂无可报名的新课程</div>'}
  </div></div>`;
}

window.selfEnroll = async (id) => {
  try { await api('POST', `/student/courses/${id}/enroll-self`);
    toast('报名成功'); stuHome();
  } catch (e) { toast(e.message, true); }
};

/* ================= 启动 ================= */
if (!loc.hash) loc.hash = '#/';
render();

/* 调试/测试钩子（生产无副作用） */
if (typeof window !== 'undefined') { window.__app = { render, get state() { return state; }, esc }; }
