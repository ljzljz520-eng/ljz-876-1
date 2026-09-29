/* ========== 基础工具 ========== */
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let auth = JSON.parse(localStorage.getItem('auth') || 'null');

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => t.className = 'toast', 2600);
}
const fmt = iso => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-';
const fmtDay = iso => iso ? new Date(iso).toLocaleString('zh-CN', { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false }) : '-';
const toLocalInput = iso => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,16); };
const ATT = { present:'正常', late:'迟到', absent:'缺课', makeup:'补签', pending:'未签到' };
const CERT = { valid:'有效', invalid:'已失效', revoked:'已吊销' };
const bClass = s => 'badge b-' + s;

function saveAuth(data) { auth = data; localStorage.setItem('auth', JSON.stringify(auth)); renderNav(); }
function logout() { auth = null; localStorage.removeItem('auth'); location.hash = '#/'; renderNav(); route(); }

function renderNav() {
  const n = document.getElementById('nav');
  if (!auth) { n.innerHTML = `<a onclick="openLogin()">登录</a><a onclick="openRegister()">注册</a>`; return; }
  const links = auth.user.role === 'organizer'
    ? `<a href="#/org/courses">我的课程</a>`
    : `<a href="#/student/home">我的学习</a><a href="#/student/catalog">课程大厅</a><a href="#/student/checkin">扫码签到</a><a href="#/student/certs">我的证书</a>`;
  n.innerHTML = `${links}<span class="who">${esc(auth.user.name)} · ${auth.user.role === 'organizer' ? '主办方' : '学员'}</span>
    <a class="btn sm ghost" onclick="logout()">退出</a>`;
}

/* ========== 弹窗 ========== */
function modal(html) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">${html}</div>`;
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);
  return mask;
}
function closeModal() { document.querySelector('.modal-mask')?.remove(); }

function openLogin(role = 'student') {
  const m = modal(`
    <h3>登录</h3>
    <div class="row" style="margin-bottom:12px">
      <button class="btn ${role==='student'?'':'ghost'} sm" onclick="closeModal();openLogin('student')">我是学员</button>
      <button class="btn ${role==='organizer'?'':'ghost'} sm" onclick="closeModal();openLogin('organizer')">我是主办方</button>
    </div>
    <div class="field"><label>用户名</label><input id="lg-u" value="${role==='student'?'student':'org'}"></div>
    <div class="field"><label>密码</label><input id="lg-p" type="password" value="123456"></div>
    <div class="row"><button class="btn" onclick="doLogin('${role}')">登录</button>
      <button class="btn gray" onclick="closeModal()">取消</button></div>
    <p class="muted small" style="margin-top:10px">演示账号：主办方 org / 学员 zhang、li、student，密码均为 123456</p>`);
  m.querySelector('#lg-p').focus();
}
async function doLogin() {
  try {
    const data = await api('/auth/login', { method:'POST', body:{ username: document.getElementById('lg-u').value.trim(), password: document.getElementById('lg-p').value }});
    saveAuth(data); closeModal(); toast('登录成功'); route();
  } catch(e){ toast(e.message, true); }
}
function openRegister() {
  const m = modal(`
    <h3>注册</h3>
    <div class="field"><label>姓名</label><input id="rg-name" placeholder="真实姓名，将印在证书上"></div>
    <div class="field"><label>用户名</label><input id="rg-u"></div>
    <div class="field"><label>密码</label><input id="rg-p" type="password"></div>
    <div class="field"><label>身份</label><select id="rg-role"><option value="student">学员</option><option value="organizer">主办方</option></select></div>
    <div class="row"><button class="btn" onclick="doRegister()">注册并登录</button>
      <button class="btn gray" onclick="closeModal()">取消</button></div>`);
}
async function doRegister() {
  try {
    const data = await api('/auth/register', { method:'POST', body:{
      name: document.getElementById('rg-name').value.trim(),
      username: document.getElementById('rg-u').value.trim(),
      password: document.getElementById('rg-p').value,
      role: document.getElementById('rg-role').value }});
    saveAuth(data); closeModal(); toast('注册成功'); route();
  } catch(e){ toast(e.message, true); }
}

/* ========== 首页 / 证书校验 ========== */
function viewHome() {
  $app.innerHTML = `
   <div class="hero">
     <h1>训成 · 培训签到与结业证书平台</h1>
     <p>主办方建课发证、学员扫码签到与测验；迟到 / 缺课 / 补签 / 补发全程留痕，旧证书失效也可追溯补发原因。</p>
     <div class="row" style="justify-content:center;margin-top:18px">
       ${auth ? '' : '<button class="btn" onclick="openLogin()">立即登录</button><button class="btn ghost" onclick="openRegister()">免费注册</button>'}
     </div>
   </div>
   <div class="features">
     <div class="feature"><div class="ic">🏷️</div><b>限时签到码</b><p>每课次生成专属签到码，含开放/关闭时间窗与宽限期；超时签到自动判为迟到，课次结束一键结算缺课。</p></div>
     <div class="feature"><div class="ic">📝</div><b>结业双门槛</b><p>考勤（迟到/缺课次数上限）与每讲测验平均分同时达标，方为结业；主办方审核后签发证书。</p></div>
     <div class="feature"><div class="ic">✅</div><b>补签留痕</b><p>主办方可为异常考勤补签或撤销补签，来源区分扫码/结算/人工，所有改动进入审计日志。</p></div>
     <div class="feature"><div class="ic">🎨</div><b>证书样式</b><p>自定义证书标题与正文模板，支持 {name} {course} 占位符，证书号含日期与随机码。</p></div>
     <div class="feature"><div class="ic">🔁</div><b>补发链可查</b><p>补发后旧证立即失效并记录原因；任何人凭旧证号/新证号都能看到完整补发链路。</p></div>
     <div class="feature"><div class="ic">🔍</div><b>公开验真</b><p>无需登录，输入证书号即可核验：是否有效、学员、课程、成绩与考勤摘要、补发记录。</p></div>
   </div>
   <div class="card verify-big">
     <h2>🔍 证书公开验真</h2>
     <div class="pill-input">
       <input id="verify-input" placeholder="输入证书号，例如 CERT-XXXXXXXX">
       <button class="btn" onclick="doVerify()">验真</button>
     </div>
     <p class="muted small" style="margin-top:8px">演示：可用张三的旧证号或新证号查询，观察两次补发记录。</p>
     <div id="verify-result"></div>
   </div>`;
}

function certChainHTML(chain, queryNo, latestId) {
  return `<div class="timeline">${chain.map(node => {
    const c = node.cert;
    const isLatest = c.id === latestId;
    return `<div class="node ${c.status}">
      <div><b>${esc(c.cert_no)}</b>
        <span class="${bClass(c.status)}">${CERT[c.status]}</span>
        ${isLatest ? '<span class="badge b-valid">当前最新</span>' : ''}
        ${String(c.cert_no) === String(queryNo) ? '<span class="badge b-pending">你查询的证号</span>' : ''}
      </div>
      <div class="kv">签发时间：<b>${fmt(c.issued_at)}</b> ｜ 考勤：${esc(c.attendance_summary)} ｜ ${esc(c.quiz_summary)}</div>
      ${node.reissue ? `<div class="reissue-note">🔁 补发说明（${fmt(node.reissue.created_at)}，操作人：${esc(node.reissue.operator_name||'主办方')}）：${esc(node.reissue.reason)}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

async function doVerify(no) {
  const certNo = (no || document.getElementById('verify-input').value).trim().toUpperCase();
  const box = document.getElementById('verify-result');
  if (!certNo) return toast('请输入证书号');
  try {
    const r = await api('/verify/' + encodeURIComponent(certNo));
    const latest = r.latest;
    box.innerHTML = `
      <div style="margin-top:16px">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">${esc(latest.course_title)}</h3>
          <span class="${bClass(latest.status)}" style="font-size:14px">${CERT[latest.status]}</span>
        </div>
        <p class="kv" style="margin-top:8px">持证人：<b>${esc(latest.student_name)}</b>（${esc(latest.student_username)}）<br>
          最新证书号：<b>${esc(latest.cert_no)}</b> ｜ 签发于 ${fmt(latest.issued_at)}</p>
        ${r.chain.length > 1 ? `<h3>补发追溯链（共 ${r.chain.length} 张证书）</h3>${certChainHTML(r.chain, certNo, latest.id)}`
          : '<p class="small muted" style="margin-top:8px">该证书无补发记录。</p>'}
      </div>`;
  } catch (e) { box.innerHTML = `<p class="progress-no" style="margin-top:12px">✗ ${esc(e.message)}</p>`; }
}

/* ========== 路由 ========== */
function route() {
  const h = location.hash || '#/';
  window.scrollTo(0, 0);
  const seg = h.slice(2).split('/');
  const need = (role) => { if (!auth) { viewHome(); toast('请先登录', true); openLogin(role); return false; } if (role && auth.user.role !== role) { viewHome(); toast('身份不匹配', true); return false; } return true; };
  try {
    if (!seg[0] || seg[0] === '') return viewHome();
    if (seg[0] === 'verify') { viewHome(); setTimeout(() => doVerify(decodeURIComponent(seg[1] || '')), 100); return; }
    if (seg[0] === 'org') {
      if (!need('organizer')) return;
      if (seg[1] === 'courses' && !seg[2]) return orgCourseList();
      if (seg[1] === 'course') return orgCourseDetail(seg[2], seg[3]);
      return orgCourseList();
    }
    if (seg[0] === 'student') {
      if (!need('student')) return;
      if (seg[1] === 'home' || !seg[1]) return studentHome();
      if (seg[1] === 'catalog') return studentCatalog();
      if (seg[1] === 'checkin') return studentCheckin();
      if (seg[1] === 'certs') return studentCerts();
      if (seg[1] === 'course') return studentCourse(seg[2]);
      if (seg[1] === 'session') return studentSession(seg[2]);
    }
    viewHome();
  } catch (e) { $app.innerHTML = `<div class="card empty">加载失败：${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
renderNav();
route();

/* ================= 主办方：课程列表 ================= */
async function orgCourseList() {
  const courses = await api('/organizer/courses');
  $app.innerHTML = `
    <div class="card">
      <h2>我的课程
        <button class="btn sm" onclick="orgNewCourse()">＋ 新建课程</button>
      </h2>
      ${courses.length ? `<table><thead><tr><th>课程</th><th>课次</th><th>学员</th><th>结业规则</th><th></th></tr></thead><tbody>
        ${courses.map(c => `<tr>
          <td><b>${esc(c.title)}</b><div class="muted small">${esc(c.description)}</div></td>
          <td>${c.session_count}</td><td>${c.student_count}</td>
          <td class="small muted">宽限${c.late_grace_min}分钟｜迟到≤${c.late_limit}｜缺课≤${c.absence_limit}｜测验≥${c.pass_score}</td>
          <td><a class="btn sm" href="#/org/course/${c.id}/sessions">管理</a></td>
        </tr>`).join('')}
      </tbody></table>` : '<div class="empty">还没有课程，点击右上角新建</div>'}
    </div>`;
}

function orgNewCourse() {
  const m = modal(`
    <h3>新建课程</h3>
    <div class="field"><label>课程名称</label><input id="nc-title" placeholder="如：消防安全培训"></div>
    <div class="field"><label>课程介绍</label><textarea id="nc-desc" rows="2"></textarea></div>
    <div class="grid2">
      <div class="field"><label>签到宽限（分钟，开课后多久内算正常）</label><input id="nc-grace" type="number" value="10"></div>
      <div class="field"><label>测验及格线（平均分）</label><input id="nc-pass" type="number" value="60"></div>
      <div class="field"><label>允许迟到次数上限</label><input id="nc-latelimit" type="number" value="3"></div>
      <div class="field"><label>允许缺课次数上限</label><input id="nc-abslimit" type="number" value="0"></div>
    </div>
    <div class="row"><button class="btn" onclick="orgCreateCourse()">创建（同时生成默认证书样式）</button>
      <button class="btn gray" onclick="closeModal()">取消</button></div>`);
}
async function orgCreateCourse() {
  const body = {
    title: document.getElementById('nc-title').value.trim(),
    description: document.getElementById('nc-desc').value.trim(),
    late_grace_min: +document.getElementById('nc-grace').value,
    pass_score: +document.getElementById('nc-pass').value,
    late_limit: +document.getElementById('nc-latelimit').value,
    absence_limit: +document.getElementById('nc-abslimit').value,
  };
  if (!body.title) return toast('请填写课程名');
  const c = await api('/organizer/courses', { method:'POST', body });
  closeModal(); toast('课程已创建'); location.hash = '#/org/course/' + c.id + '/sessions';
}

/* ================= 主办方：课程详情 ================= */
async function orgCourseDetail(cid, tab = 'sessions') {
  const course = await api('/organizer/courses/' + cid);
  const tabs = [['sessions','课次与签到码'],['students','学员与结业'],['templates','证书样式'],['certs','证书管理']];
  $app.innerHTML = `
    <div class="card">
      <h2>${esc(course.title)}
        <a class="btn sm gray" href="#/org/courses">← 返回列表</a>
      </h2>
      <p class="muted">${esc(course.description)}</p>
      <div class="stat small" style="margin-top:6px">
        <span class="chip">签到宽限 <b>${course.late_grace_min} 分钟</b></span>
        <span class="chip">迟到上限 <b>${course.late_limit}</b></span>
        <span class="chip">缺课上限 <b>${course.absence_limit}</b></span>
        <span class="chip">测验及格 <b>${course.pass_score} 分</b></span>
      </div>
    </div>
    <div class="tabs">${tabs.map(([k,n]) => `<a class="${tab===k?'active':''}" href="#/org/course/${cid}/${k}">${n}</a>`).join('')}</div>
    <div id="tab-body"></div>`;
  if (tab === 'sessions') await orgTabSessions(cid, course);
  if (tab === 'students') await orgTabStudents(cid, course);
  if (tab === 'templates') await orgTabTemplates(cid);
  if (tab === 'certs') await orgTabCerts(cid);
}

/* ---- 课次 / 签到码 ---- */
async function orgTabSessions(cid, course) {
  const sessions = await api(`/organizer/courses/${cid}/sessions`);
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h2>课次列表 <button class="btn sm" onclick='orgNewSession(${cid})'>＋ 新建课次</button></h2>
      ${sessions.map(s => {
        const now = Date.now();
        const activeCode = s.codes.find(c => c.active && now >= new Date(c.valid_from) && now <= new Date(c.valid_until));
        return `<div class="card" style="box-shadow:none;margin-bottom:12px">
          <div class="row" style="justify-content:space-between">
            <div><b>${esc(s.title)}</b>
              <div class="small muted">${fmt(s.start_time)} ~ ${fmt(s.end_time)}</div>
            </div>
            <div class="row">
              <button class="btn sm ghost" onclick='orgGenCode(${s.id})'>🔄 生成/重置签到码</button>
              <button class="btn sm gray" onclick='orgSettle(${s.id})'>结算缺课</button>
            </div>
          </div>
          ${activeCode ? `<div class="codebox" style="margin-top:12px">${activeCode.code}</div>
            <p class="small muted" style="text-align:center;margin-top:6px">签到窗口：${fmt(activeCode.valid_from)} ～ ${fmt(activeCode.valid_until)}（超过开课后${course.late_grace_min}分钟签到记迟到）</p>`
            : '<p class="small muted" style="margin-top:8px">当前无有效签到码，可重新生成。</p>'}
          <div class="row" style="margin-top:10px">
            <button class="btn sm ghost" onclick='orgEditQuiz(${s.id})'>📝 编辑本讲测验</button>
            <button class="btn sm ghost" onclick='orgViewAttendance(${s.id},${JSON.stringify(s.title)})'>👥 考勤明细与补签</button>
          </div>
          ${s.codes.length ? `<details class="small" style="margin-top:8px"><summary class="muted">历史签到码（${s.codes.length}）</summary>
            <table style="margin-top:6px"><tbody>${s.codes.map(c=>`<tr><td><b>${c.code}</b></td><td>${fmt(c.valid_from)}~${fmt(c.valid_until)}</td>
              <td><span class="badge ${c.active?'b-valid':'b-pending'}">${c.active?'启用中':'已停用'}</span></td>
              <td><button class="btn sm gray" onclick='orgToggleCode(${c.id})'>${c.active?'停用':'启用'}</button></td></tr>`).join('')}</tbody></table></details>`:''}
        </div>`;
      }).join('') || '<div class="empty">暂无课次</div>'}
    </div>`;
}

function orgNewSession(cid) {
  const start = new Date(Date.now() + 3600000); start.setMinutes(0,0,0);
  const end = new Date(start.getTime() + 3600000);
  modal(`<h3>新建课次</h3>
    <div class="field"><label>课次标题</label><input id="ns-title" placeholder="如：第一讲 基础理论"></div>
    <div class="field"><label>开始时间</label><input id="ns-start" type="datetime-local" value="${toLocalInput(start.toISOString())}"></div>
    <div class="field"><label>结束时间</label><input id="ns-end" type="datetime-local" value="${toLocalInput(end.toISOString())}"></div>
    <div class="row"><button class="btn" onclick='orgCreateSession(${cid})'>创建</button>
      <button class="btn gray" onclick="closeModal()">取消</button></div>
    <p class="small muted" style="margin-top:8px">创建后在课次卡片上点击“生成签到码”，学员即可在开放窗口内扫码。</p>`);
}
async function orgCreateSession(cid) {
  const body = {
    title: document.getElementById('ns-title').value.trim(),
    start_time: new Date(document.getElementById('ns-start').value).toISOString(),
    end_time: new Date(document.getElementById('ns-end').value).toISOString(),
  };
  if (!body.title) return toast('请填写标题');
  await api(`/organizer/courses/${cid}/sessions`, { method:'POST', body });
  closeModal(); toast('课次已创建'); route();
}
async function orgGenCode(sid, openBefore, openAfter) {
  const c = await api(`/organizer/sessions/${sid}/code`, { method:'POST', body:{ open_before: openBefore ?? 15, open_after: openAfter ?? 120 }});
  toast('签到码：' + c.code); route();
}
async function orgToggleCode(id) {
  await api(`/organizer/codes/${id}/toggle`, { method:'POST' }); toast('已更新'); route();
}
async function orgSettle(sid) {
  if (!confirm('结算后，本课次所有未签到的在学学员将被记为「缺课」，可后续补签。继续？')) return;
  const r = await api(`/organizer/sessions/${sid}/settle`, { method:'POST' });
  toast(`结算完成，新增缺课 ${r.settled} 人`); route();
}

/* ---- 考勤明细 + 补签 ---- */
async function orgViewAttendance(sid, title) {
  const data = await api(`/organizer/sessions/${sid}/attendance`);
  modal(`<h3>考勤明细 · ${esc(title || ('课次 #' + sid))}</h3>
    <p class="small muted">状态说明：正常 / 迟到（扫码自动判定）/ 缺课（结算）/ 补签（人工）。每次改动均写入审计日志。</p>
    <table><thead><tr><th>学员</th><th>状态</th><th>来源</th><th>时间</th><th>备注</th><th>操作</th></tr></thead><tbody>
    ${data.rows.length ? data.rows.map(a => `<tr>
      <td>${esc(a.student_name)}</td>
      <td><span class="${bClass(a.status)}">${ATT[a.status]}</span></td>
      <td class="small">${{scan:'扫码',manual:'人工结算',makeup:'补签'}[a.source]}</td>
      <td class="small">${fmt(a.checked_at)}</td>
      <td class="small muted">${esc(a.note)}</td>
      <td><button class="btn sm ghost" onclick='orgMakeup(${a.id},${JSON.stringify(a.status)},${JSON.stringify(a.note||'')})'>处理</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">暂无考勤记录（可先“结算缺课”）</td></tr>'}
    </tbody></table>
    <h3 style="margin-top:16px">审计日志</h3>
    ${data.logs.length ? `<ul class="plain small">${data.logs.map(l => `<li>· ${fmt(l.created_at)} <b>${esc(l.actor_name)}</b>
      {scan:扫码,settle:结算缺课,makeup:补签处理,revoke_makeup:撤销补签}[${l.action}] ${esc(l.detail)}</li>`).join('')}</ul>`
      : '<p class="small muted">无</p>'}
    <div class="row" style="margin-top:12px"><button class="btn gray" onclick="closeModal()">关闭</button></div>`);
}

function orgMakeup(aid, oldStatus, oldNote) {
  modal(`<h3>处理考勤记录</h3>
    <div class="field"><label>调整为状态</label>
      <select id="mk-status">
        <option value="makeup" ${oldStatus==='makeup'?'selected':''}>补签（视为出勤，标记为人工补签）</option>
        <option value="present" ${oldStatus==='present'?'selected':''}>正常</option>
        <option value="late" ${oldStatus==='late'?'selected':''}>迟到</option>
        <option value="absent" ${oldStatus==='absent'?'selected':''}>缺课（撤销补签/恢复缺课）</option>
      </select></div>
    <div class="field"><label>原因 / 说明（将记录在审计日志）</label>
      <textarea id="mk-note" rows="2">${esc(oldNote)}</textarea></div>
    <div class="row"><button class="btn" onclick='orgDoMakeup(${aid})'>提交处理</button>
      <button class="btn gray" onclick="closeModal()">取消</button></div>`);
}
async function orgDoMakeup(aid) {
  await api(`/organizer/attendance/${aid}/makeup`, { method:'POST', body:{
    status: document.getElementById('mk-status').value, note: document.getElementById('mk-note').value.trim() }});
  closeModal(); toast('考勤已更新，并已记录日志'); route();
}

/* ---- 测验编辑 ---- */
let quizDraft = [];
async function orgEditQuiz(sid) {
  const exist = await api(`/organizer/sessions/${sid}/quiz`).catch(() => null);
  quizDraft = exist ? exist.questions.map(q => ({ ...q, options: [...q.options] }))
    : [{ q:'', options:['','','',''], answer:0, score:10 }];
  const render = () => {
    const box = document.getElementById('quiz-editor');
    box.innerHTML = `
      <div class="field"><label>测验标题</label><input id="qz-title" value="${esc(exist?.title||'课后测验')}"></div>
      ${quizDraft.map((q,qi)=>`<div class="quiz-q">
        <div class="row" style="justify-content:space-between"><b>第 ${qi+1} 题</b>
          <label class="small">分值 <input style="width:70px" type="number" value="${q.score}" onchange="quizDraft[${qi}].score=+this.value"></label>
          ${quizDraft.length>1?`<button class="btn sm danger" onclick="quizDraft.splice(${qi},1);render()">删除</button>`:''}
        </div>
        <input style="width:100%;margin:6px 0" placeholder="题干" value="${esc(q.q)}" onchange="quizDraft[${qi}].q=this.value">
        ${q.options.map((o,oi)=>`<label class="opt"><input type="radio" name="ans${qi}" ${q.answer===oi?'checked':''}
          onchange="quizDraft[${qi}].answer=${oi}">
          <input style="width:82%" placeholder="选项${oi+1}" value="${esc(o)}" onchange="quizDraft[${qi}].options[${oi}]=this.value"></label>`).join('')}
      </div>`).join('')}
      <button class="btn ghost sm" onclick="quizDraft.push({q:'',options:['','','',''],answer:0,score:10});render()">＋ 添加题目</button>`;
  };
  modal(`<h3>编辑本讲测验（单选题，取学员最高分）</h3><div id="quiz-editor"></div>
    <div class="row" style="margin-top:14px"><button class="btn" onclick='orgSaveQuiz(${sid})'>保存测验</button>
      <button class="btn gray" onclick="closeModal()">取消</button></div>`);
  window.render = render; render();
}
async function orgSaveQuiz(sid) {
  const title = document.getElementById('qz-title').value.trim() || '课后测验';
  for (const q of quizDraft) {
    if (!q.q || q.options.some(o => !o.trim())) return toast('存在未填写的题干或选项');
  }
  await api(`/organizer/sessions/${sid}/quiz`, { method:'PUT', body:{ title, questions: quizDraft }});
  closeModal(); toast('测验已保存');
}

/* ---- 学员与结业总览 ---- */
async function orgTabStudents(cid, course) {
  const students = await api(`/organizer/courses/${cid}/students`);
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h2>学员结业总览
        <button class="btn sm ghost" onclick='orgAddStudent(${cid})'>＋ 录入学员报名</button>
      </h2>
      ${students.length ? `<table><thead><tr><th>学员</th><th>考勤</th><th>测验均分</th><th>结业判定</th><th>操作</th></tr></thead><tbody>
        ${students.map(st => { const p = st.progress; return `<tr>
          <td><b>${esc(st.name)}</b><div class="small muted">${esc(st.username)}</div></td>
          <td class="small">
            <span class="badge b-present">正常${p.counts.present}</span>
            <span class="badge b-late">迟到${p.counts.late}</span>
            <span class="badge b-makeup">补签${p.counts.makeup}</span>
            <span class="badge b-absent">缺课${p.counts.absent}</span>
            <span class="badge b-pending">待签${p.counts.pending}</span>
          </td>
          <td>${p.quizAvg===null?'<span class="muted">未考</span>':`<b>${p.quizAvg}</b> / ${course.pass_score}`}</td>
          <td>${p.qualified?'<span class="progress-ok">✓ 达到结业条件</span>'
            :`<span class="progress-no">✗ 未达标</span><div class="small muted">${p.failReasons.map(esc).join('；')}</div>`}</td>
          <td><button class="btn sm ${p.qualified?'':'ghost'}" onclick='orgIssue(${cid},${st.id},${p.qualified})'>签发证书</button></td>
        </tr>`;}).join('')}
      </tbody></table>` : '<div class="empty">还没有学员报名</div>'}
    </div>`;
}
async function orgAddStudent(cid) {
  modal(`<h3>录入学员报名</h3>
    <div class="field"><label>学员用户 ID</label><input id="as-sid" type="number" placeholder="学员注册后获得的数字ID" style="width:160px"></div>
    <p class="small muted">演示中可让学员先在“课程大厅”自助报名；这里供主办方代录。</p>
    <div class="row"><button class="btn" onclick='orgDoAddStudent(${cid})'>确认报名</button>
      <button class="btn gray" onclick="closeModal()">取消</button></div>`);
}
async function orgDoAddStudent(cid) {
  const student_id = +document.getElementById('as-sid').value;
  if (!student_id) return toast('请填写学员 ID');
  await api(`/organizer/courses/${cid}/students`, { method:'POST', body:{ student_id }});
  closeModal(); toast('报名成功'); route();
}
async function orgIssue(cid, studentId, qualified) {
  if (!qualified) { if (!confirm('该学员尚未达到结业条件，确定仍要尝试签发？（系统会拒绝）')) return; }
  try { const c = await api(`/organizer/courses/${cid}/issue`, { method:'POST', body:{ student_id: studentId }});
    toast('证书已签发：' + c.cert_no); route();
  } catch(e){ toast(e.message, true); }
}

/* ---- 证书样式 ---- */
async function orgTabTemplates(cid) {
  const tpls = await api(`/organizer/courses/${cid}/templates`);
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h2>证书样式 <button class="btn sm" onclick='orgNewTemplate(${cid})'>＋ 新建样式</button></h2>
      <div class="grid2">${tpls.map(t => `
        <div class="card" style="box-shadow:none">
          <b>${esc(t.name)}</b>
          <div class="cert-paper" style="margin-top:10px;padding:22px">
            <h1 style="font-size:22px;letter-spacing:6px">${esc(t.title_text)}</h1>
            <div class="body small" style="font-size:13px">${esc(t.body_text)}</div>
            <div class="meta small"><span>编号：CERT-XXXX-XXXX</span><span>${new Date().getFullYear()} 年</span></div>
          </div>
          <p class="small muted" style="margin-top:8px">占位符：{name} 学员姓名 · {course} 课程名</p>
        </div>`).join('')}</div>
    </div>`;
}
function orgNewTemplate(cid) {
  modal(`<h3>新建证书样式</h3>
    <div class="field"><label>样式名称</label><input id="tpl-name" placeholder="如：标准版 / 优秀学员版"></div>
    <div class="field"><label>证书标题</label><input id="tpl-title" value="结业证书"></div>
    <div class="field"><label>正文（支持 {name} {course}）</label>
      <textarea id="tpl-body" rows="4">兹证明 {name} 已完成《{course}》全部课程，考勤与测验合格，特发此证。</textarea></div>
    <div class="row"><button class="btn" onclick='orgDoNewTemplate(${cid})'>创建</button>
      <button class="btn gray" onclick="closeModal()">取消</button></div>`);
}
async function orgDoNewTemplate(cid) {
  await api(`/organizer/courses/${cid}/templates`, { method:'POST', body:{
    name: document.getElementById('tpl-name').value.trim() || '证书样式',
    title_text: document.getElementById('tpl-title').value.trim(),
    body_text: document.getElementById('tpl-body').value.trim() }});
  closeModal(); toast('样式已创建'); route();
}

/* ---- 证书管理 ---- */
async function orgTabCerts(cid) {
  const certs = await api(`/organizer/courses/${cid}/certificates`);
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h2>证书签发记录</h2>
      <p class="small muted">补发时系统会重新校验结业条件：旧证置为「已失效」并强制记录原因；已失效证书不能再次补发，需从当前最新证补发。</p>
      ${certs.length ? `<table><thead><tr><th>证书号</th><th>学员</th><th>状态</th><th>考勤/测验摘要</th><th>签发时间</th><th>操作</th></tr></thead><tbody>
        ${certs.map(c => `<tr>
          <td><b>${esc(c.cert_no)}</b>${c.invalid_reason?`<div class="small" style="color:var(--red)">${esc(c.invalid_reason)}</div>`:''}</td>
          <td>${esc(c.student_name)}</td>
          <td><span class="${bClass(c.status)}">${CERT[c.status]}</span></td>
          <td class="small muted">${esc(c.attendance_summary)}<br>${esc(c.quiz_summary)}</td>
          <td class="small">${fmt(c.issued_at)}</td>
          <td class="row">
            <a class="btn sm ghost" target="_blank" href="#/verify/${c.cert_no}">验真页</a>
            ${c.status==='valid'?`<button class="btn sm" onclick='orgReissue(${c.id})'>补发</button>
              <button class="btn sm danger" onclick='orgRevoke(${c.id})'>吊销</button>`
              : '<span class="small muted">不可操作</span>'}
          </td>
        </tr>`).join('')}
      </tbody></table>` : '<div class="empty">尚未签发任何证书</div>'}
    </div>`;
}
function orgReissue(cidCert) {
  modal(`<h3>补发证书</h3>
    <div class="field"><label>补发原因（必填，会永久附在旧证书的失效记录上）</label>
      <select id="ri-reason" onchange="document.getElementById('ri-text').value=this.value">
        <option value="">请选择…</option>
        <option>原证书信息打印错误，申请换发</option>
        <option>证书遗失，申请补办</option>
        <option>证书污损，申请补办</option>
        <option>学员更名后换发</option>
      </select></div>
    <div class="field"><textarea id="ri-text" rows="3" placeholder="也可手动填写具体原因"></textarea></div>
    <p class="small muted">提交后：原证书立即失效 → 生成新证书号 → 记录补发人与原因，公开验真可查完整链路。</p>
    <div class="row"><button class="btn" onclick='orgDoReissue(${cidCert})'>确认补发</button>
      <button class="btn gray" onclick="closeModal()">取消</button></div>`);
}
async function orgDoReissue(id) {
  const reason = document.getElementById('ri-text').value.trim();
  if (!reason) return toast('请填写补发原因');
  try {
    const r = await api(`/organizer/certificates/${id}/reissue`, { method:'POST', body:{ reason }});
    closeModal(); toast(`已补发，新证号 ${r.fresh.cert_no}`); route();
  } catch(e){ toast(e.message, true); }
}
function orgRevoke(id) {
  modal(`<h3>吊销证书</h3>
    <div class="field"><label>吊销原因</label>
      <textarea id="rv-reason" rows="3" placeholder="如：结业材料造假 / 违反培训纪律"></textarea></div>
    <div class="row"><button class="btn danger" onclick='orgDoRevoke(${id})'>确认吊销</button>
      <button class="btn gray" onclick="closeModal()">取消</button></div>`);
}
async function orgDoRevoke(id) {
  const reason = document.getElementById('rv-reason').value.trim() || '违规';
  await api(`/organizer/certificates/${id}/revoke`, { method:'POST', body:{ reason }});
  closeModal(); toast('证书已吊销'); route();
}

/* ================= 学员端 ================= */
function progressBarHTML(p, course) {
  const c = p.counts;
  const reasons = p.qualified ? '' : p.failReasons.map(esc).join('；');
  return `<div class="stat small">
    <span class="chip">正常 <b>${c.present}</b></span>
    <span class="chip">迟到 <b>${c.late}</b></span>
    <span class="chip">补签 <b>${c.makeup}</b></span>
    <span class="chip">缺课 <b>${c.absent}</b></span>
    <span class="chip">待签 <b>${c.pending}</b></span>
    <span class="chip">测验均分 <b>${p.quizAvg ?? '—'}</b> / ${course.pass_score}</span>
  </div>
  <p style="margin-top:8px" class="${p.qualified?'progress-ok':'progress-no'}">
    ${p.qualified ? '✓ 已达到结业条件，等待主办方签发证书' : '✗ ' + reasons}</p>`;
}

async function studentHome() {
  const courses = await api('/student/courses');
  $app.innerHTML = `<div class="card"><h2>我的学习
    <a class="btn sm ghost" href="#/student/catalog">去课程大厅报名</a></h2>
    ${courses.length ? courses.map(c => `
      <div class="card" style="box-shadow:none">
        <div class="row" style="justify-content:space-between">
          <div><b style="font-size:15px">${esc(c.title)}</b>
            <div class="small muted">共 ${c.progress.counts.total} 次课 ｜ 规则：迟到≤${c.late_limit}、缺课≤${c.absence_limit}、测验均分≥${c.pass_score}</div>
          </div>
          <a class="btn sm" href="#/student/course/${c.id}">进入课程</a>
        </div>
        ${progressBarHTML(c.progress, c)}
      </div>`).join('') : '<div class="empty">还没有报名课程，去课程大厅看看吧</div>'}
  </div>
  <div class="card"><h2>快捷签到</h2>
    <p class="muted small">线下课现场，讲师会在大屏展示限时签到码。</p>
    <a class="btn" href="#/student/checkin">📷 输入签到码签到</a></div>`;
}

async function studentCatalog() {
  const list = await api('/student/catalog');
  $app.innerHTML = `<div class="card"><h2>课程大厅</h2>
    ${list.map(c => `<div class="card" style="box-shadow:none">
      <div class="row" style="justify-content:space-between">
        <div><b>${esc(c.title)}</b><div class="small muted">主办方：${esc(c.organizer_name)}</div>
        <div class="small" style="margin-top:4px">${esc(c.description)}</div></div>
        ${c.enrolled ? '<span class="badge b-valid">已报名</span>'
          : `<button class="btn sm" onclick='studentEnroll(${c.id})'>报名参加</button>`}
      </div></div>`).join('') || '<div class="empty">暂无可报名课程</div>'}</div>`;
}
async function studentEnroll(id) {
  await api(`/student/courses/${id}/enroll`, { method:'POST' }); toast('报名成功'); route();
}

async function studentCourse(cid) {
  const [coursesRaw] = await Promise.all([api('/student/courses')]);
  const c = coursesRaw.find(x => x.id === +cid);
  if (!c) { $app.innerHTML = '<div class="card empty">未报名该课程</div>'; return; }
  const p = c.progress;
  $app.innerHTML = `
    <div class="card">
      <h2>${esc(c.title)} <a class="btn sm gray" href="#/student/home">← 返回</a></h2>
      ${progressBarHTML(p, c)}
    </div>
    <div class="card"><h2>课次安排</h2>
      <table><thead><tr><th>课次</th><th>时间</th><th>我的考勤</th><th>测验</th><th></th></tr></thead><tbody>
      ${p.attendance.map(a => `<tr>
        <td><b>${esc(a.title)}</b></td>
        <td class="small">${fmt(a.start_time)}</td>
        <td><span class="${bClass(a.status)}">${ATT[a.status]}</span>
          ${a.note?`<div class="small muted">${esc(a.note)}</div>`:''}</td>
        <td>${a.status==='pending'?'<span class="small muted">—</span>':'<span class="small">课后完成</span>'}</td>
        <td><a class="btn sm ${a.status==='pending'?'':'ghost'}" href="#/student/session/${a.session_id}">进入</a></td>
      </tr>`).join('')}
      </tbody></table>
    </div>`;
}

async function studentCheckin() {
  $app.innerHTML = `<div class="card" style="max-width:520px;margin:0 auto;text-align:center">
    <h2 style="justify-content:center">📷 扫码 / 输入签到码</h2>
    <p class="muted small">签到码仅在讲师开放的时间窗内有效；超过开课后宽限期将记为「迟到」，窗口关闭后只能联系主办方补签。</p>
    <input id="ci-code" style="width:100%;font-size:28px;text-align:center;letter-spacing:6px;margin:18px 0"
      placeholder="如 SAFE01" maxlength="16" autocomplete="off">
    <button class="btn" style="width:100%;padding:12px" onclick="studentDoCheckin()">立即签到</button>
    <div id="ci-result"></div>
    <p class="small muted" style="margin-top:14px">演示：第一讲签到码 <b>SAFE01</b>（当前处于签到窗口）</p>
  </div>`;
  const input = document.getElementById('ci-code');
  input.focus();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') studentDoCheckin(); });
}
async function studentDoCheckin() {
  const code = document.getElementById('ci-code').value.trim();
  const box = document.getElementById('ci-result');
  if (!code) return toast('请输入签到码');
  try {
    const r = await api('/student/checkin', { method:'POST', body:{ code }});
    box.innerHTML = `<p class="progress-ok" style="margin-top:14px;font-size:16px">
      ✓ 签到成功！《${esc(r.session_title)}》— ${r.status==='late'?'已记为迟到':'出勤正常'}</p>`;
    toast(r.status === 'late' ? '签到成功（迟到）' : '签到成功');
  } catch (e) { box.innerHTML = `<p class="progress-no" style="margin-top:14px">✗ ${esc(e.message)}</p>`; }
}

async function studentSession(sid) {
  const d = await api('/student/sessions/' + sid);
  const s = d.session;
  $app.innerHTML = `<div class="card">
    <h2>${esc(s.title)}</h2>
    <p class="small muted">${fmt(s.start_time)} ~ ${fmt(s.end_time)}</p>
    <p style="margin-top:10px">我的考勤：
      <span class="${bClass(d.attendance?.status||'pending')}" style="font-size:15px">
      ${d.attendance ? ATT[d.attendance.status] : '尚未签到'}</span>
      ${d.attendance?.note?`<span class="small muted">（${esc(d.attendance.note)}）</span>`:''}</p>
    ${!d.attendance?`<a class="btn" style="margin-top:10px" href="#/student/checkin">去签到</a>`:''}
  </div>
  <div class="card" id="quiz-card"></div>`;
  const qc = document.getElementById('quiz-card');
  if (!d.quiz) { qc.innerHTML = '<h2>本讲测验</h2><div class="empty">主办方暂未发布测验</div>'; return; }
  qc.innerHTML = `<h2>📝 ${esc(d.quiz.title)}
    ${d.myBest!==null?`<span class="small muted">历史最高分：<b style="color:var(--blue)">${d.myBest}</b>（可重复作答取最高）</span>`:''}</h2>
    <div id="quiz-area"></div>
    <button class="btn" onclick='studentSubmitQuiz(${d.quiz.id})'>提交答卷</button>`;
  document.getElementById('quiz-area').innerHTML = d.quiz.questions.map((q,qi)=>`
    <div class="quiz-q"><b>${qi+1}. ${esc(q.q)}</b> <span class="small muted">（${q.score}分）</span>
    ${q.options.map((o,oi)=>`<label class="opt"><input type="radio" name="q${qi}" value="${oi}"> ${esc(o)}</label>`).join('')}
    </div>`).join('');
}
async function studentSubmitQuiz(qid) {
  const qs = document.querySelectorAll('#quiz-area .quiz-q');
  const answers = [...qs].map((q,i) => {
    const v = q.querySelector(`input[name=q${i}]:checked`); return v ? +v.value : -1;
  });
  if (answers.some(a => a < 0)) return toast('还有题目未作答');
  const r = await api(`/student/quizzes/${qid}/submit`, { method:'POST', body:{ answers }});
  toast(`本次得分 ${r.score}，历史最高 ${r.best}`); route();
}

async function studentCerts() {
  const certs = await api('/student/certificates');
  $app.innerHTML = `<div class="card"><h2>我的证书</h2>
    ${certs.length ? certs.map(c => `
      <div class="grid2" style="align-items:start">
        <div class="cert-paper">
          <h1>结业证书</h1>
          <div class="body">兹证明 <b style="font-size:20px">${esc(auth.user.name)}</b><br>
            已完成《<b>${esc(c.course_title)}</b>》全部课程<br>考勤与测验合格，特发此证。</div>
          <div class="meta"><span>证书编号：${esc(c.cert_no)}</span><span>${new Date(c.issued_at).toLocaleDateString('zh-CN')}</span></div>
          <div style="margin-top:12px"><span class="${bClass(c.status)}" style="font-size:14px">${CERT[c.status]}</span>
            ${c.invalid_reason?`<div class="small" style="color:var(--red);margin-top:6px">${esc(c.invalid_reason)}</div>`:''}</div>
        </div>
        <div>
          <p class="kv">${esc(c.attendance_summary)}<br>${esc(c.quiz_summary)}<br>签发时间：${fmt(c.issued_at)}</p>
          <div class="row" style="margin-top:12px">
            <a class="btn sm ghost" target="_blank" href="#/verify/${c.cert_no}">查看验真/补发链</a>
          </div>
          ${c.status!=='valid'?'<p class="small muted" style="margin-top:10px">该证书已失效，如需有效证明，请联系主办方补发。</p>':''}
        </div>
      </div><hr style="border:none;margin:18px 0">`).join('') : '<div class="empty">还没有证书，完成考勤与测验后由主办方签发</div>'}
  </div>`;
}
