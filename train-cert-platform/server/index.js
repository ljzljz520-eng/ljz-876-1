const path = require('path');
const express = require('express');
const S = require('./services');
const db = S.db;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => {
  console.error(e);
  res.status(400).json({ error: e.message });
});
const body = (req, keys) => { for (const k of keys) if (req.body[k] === undefined) throw new Error(`缺少参数 ${k}`); return req.body; };

/* ---------------- 认证 ---------------- */
app.post('/api/auth/register', wrap((req, res) => {
  const { username, password, name, role } = body(req, ['username', 'password', 'name', 'role']);
  if (!['organizer', 'student'].includes(role)) throw new Error('角色非法');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw new Error('用户名已存在');
  const info = db.prepare('INSERT INTO users(username,password,name,role,created_at) VALUES (?,?,?,?,?)')
    .run(username, S.sha(password), name, role, S.nowISO());
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  res.json({ token: S.createToken(user), user: { id: user.id, username, name, role } });
}));

app.post('/api/auth/login', wrap((req, res) => {
  const { username, password } = body(req, ['username', 'password']);
  const user = db.prepare('SELECT * FROM users WHERE username=? AND password=?').get(username, S.sha(password));
  if (!user) throw new Error('用户名或密码错误');
  res.json({ token: S.createToken(user), user: { id: user.id, username, name: user.name, role: user.role } });
}));

/* ---------------- 公共：证书校验 ---------------- */
// 证书号 -> 证书 + 补发链（旧证失效后仍能查到为何补发）
app.get('/api/verify/:certNo', wrap((req, res) => {
  const cert = db.prepare(`SELECT c.*, co.title course_title, u.name student_name, u.username student_username
    FROM certificates c JOIN courses co ON co.id=c.course_id JOIN users u ON u.id=c.student_id
    WHERE c.cert_no=?`).get(req.params.certNo);
  if (!cert) return res.status(404).json({ error: '证书号不存在' });
  // 先沿 superseded_by 找到链上最新证书，再反向逐级回溯，得到 旧→新 的完整补发链
  let latest = cert;
  const seen = new Set();
  while (latest.superseded_by && !seen.has(latest.id)) {
    seen.add(latest.id);
    latest = db.prepare('SELECT * FROM certificates WHERE id=?').get(latest.superseded_by);
  }
  const chain = [];
  let cur = latest; seen.clear();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const reissue = db.prepare(`SELECT r.*, u.name operator_name FROM reissues r
      LEFT JOIN users u ON u.id=r.operator_id WHERE r.new_cert_id=?`).get(cur.id) || null;
    chain.unshift({ cert: cur, reissue }); // 插到队首，最终顺序：最早 → 最新
    cur = db.prepare('SELECT * FROM certificates WHERE superseded_by=?').get(cur.id) || null;
  }
  res.json({ query: cert, latest, chain });
}));

/* ---------------- 主办方：课程 ---------------- */
app.get('/api/organizer/courses', S.requireAuth('organizer'), wrap((req, res) => {
  res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM sessions WHERE course_id=c.id) session_count,
    (SELECT COUNT(*) FROM enrollments WHERE course_id=c.id AND status='active') student_count
    FROM courses c WHERE c.organizer_id=? ORDER BY c.id DESC`).all(req.user.uid));
}));

app.post('/api/organizer/courses', S.requireAuth('organizer'), wrap((req, res) => {
  const b = body(req, ['title']);
  const info = db.prepare(`INSERT INTO courses(organizer_id,title,description,late_grace_min,late_limit,absence_limit,pass_score,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(req.user.uid, b.title, b.description || '',
    b.late_grace_min ?? 10, b.late_limit ?? 3, b.absence_limit ?? 0, b.pass_score ?? 60, S.nowISO());
  // 自动建一个默认证书样式
  db.prepare('INSERT INTO certificate_templates(course_id,name,title_text,body_text,created_at) VALUES (?,?,?,?,?)')
    .run(info.lastInsertRowid, '默认样式', '结业证书',
      '兹证明 {name} 已完成《{course}》全部课程，考勤与测验合格，特发此证。', S.nowISO());
  res.json(db.prepare('SELECT * FROM courses WHERE id=?').get(info.lastInsertRowid));
}));

app.get('/api/organizer/courses/:id', S.requireAuth('organizer'), wrap((req, res) => {
  const c = db.prepare('SELECT * FROM courses WHERE id=? AND organizer_id=?').get(req.params.id, req.user.uid);
  if (!c) throw new Error('课程不存在或无权查看');
  res.json(c);
}));

/* ---------------- 主办方：课次与签到码 ---------------- */
app.get('/api/organizer/courses/:id/sessions', S.requireAuth('organizer'), wrap((req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions WHERE course_id=? ORDER BY start_time').all(req.params.id);
  res.json(sessions.map(s => ({
    ...s,
    codes: db.prepare('SELECT * FROM codes WHERE session_id=? ORDER BY id DESC').all(s.id),
  })));
}));

app.post('/api/organizer/courses/:id/sessions', S.requireAuth('organizer'), wrap((req, res) => {
  const b = body(req, ['title', 'start_time', 'end_time']);
  const info = db.prepare('INSERT INTO sessions(course_id,title,start_time,end_time,created_at) VALUES (?,?,?,?,?)')
    .run(req.params.id, b.title, b.start_time, b.end_time, S.nowISO());
  res.json(db.prepare('SELECT * FROM sessions WHERE id=?').get(info.lastInsertRowid));
}));

// 生成签到码（窗口：开课前 open_before 分钟 ~ 开课后 open_after 分钟）
app.post('/api/organizer/sessions/:sid/code', S.requireAuth('organizer'), wrap((req, res) => {
  const ses = db.prepare(`SELECT s.* FROM sessions s JOIN courses c ON c.id=s.course_id
    WHERE s.id=? AND c.organizer_id=?`).get(req.params.sid, req.user.uid);
  if (!ses) throw new Error('课次不存在');
  const b = req.body || {};
  const start = new Date(ses.start_time), end = new Date(ses.end_time);
  const openBefore = Number.isInteger(b.open_before) ? b.open_before : 15;
  const openAfter = Number.isInteger(b.open_after) ? b.open_after : Math.max(10, Math.round((end - start) / 60000));
  const validFrom = new Date(start.getTime() - openBefore * 60000).toISOString();
  const validUntil = new Date(start.getTime() + openAfter * 60000).toISOString();
  // 旧码失效，保证一课次一个有效码
  db.prepare('UPDATE codes SET active=0 WHERE session_id=?').run(req.params.sid);
  let code;
  do { code = (b.code || S.uid(3)).toUpperCase().slice(0, 16); }
  while (db.prepare('SELECT 1 FROM codes WHERE code=?').get(code));
  const info = db.prepare('INSERT INTO codes(session_id,code,valid_from,valid_until,active,created_at) VALUES (?,?,?,?,1,?)')
    .run(req.params.sid, code, validFrom, validUntil, S.nowISO());
  res.json(db.prepare('SELECT * FROM codes WHERE id=?').get(info.lastInsertRowid));
}));

app.post('/api/organizer/codes/:id/toggle', S.requireAuth('organizer'), wrap((req, res) => {
  const code = db.prepare(`SELECT co.* FROM codes co JOIN sessions s ON s.id=co.session_id
    JOIN courses c ON c.id=s.course_id WHERE co.id=? AND c.organizer_id=?`).get(req.params.id, req.user.uid);
  if (!code) throw new Error('签到码不存在');
  db.prepare('UPDATE codes SET active=? WHERE id=?').run(code.active ? 0 : 1, code.id);
  res.json(db.prepare('SELECT * FROM codes WHERE id=?').get(code.id));
}));

// 手动结算课次缺课
app.post('/api/organizer/sessions/:sid/settle', S.requireAuth('organizer'), wrap((req, res) => {
  const ses = db.prepare(`SELECT s.* FROM sessions s JOIN courses c ON c.id=s.course_id
    WHERE s.id=? AND c.organizer_id=?`).get(req.params.sid, req.user.uid);
  if (!ses) throw new Error('课次不存在');
  const n = S.settleSession(req.params.sid, req.user);
  res.json({ settled: n });
}));

/* ---------------- 主办方：学员 / 考勤 / 补签 ---------------- */
app.get('/api/organizer/courses/:id/students', S.requireAuth('organizer'), wrap((req, res) => {
  const list = db.prepare(`SELECT u.id, u.name, u.username, e.enrolled_at FROM enrollments e
    JOIN users u ON u.id=e.student_id WHERE e.course_id=? AND e.status='active'`).all(req.params.id);
  res.json(list.map(st => ({ ...st, progress: S.getProgress(Number(req.params.id), st.id) })));
}));

app.post('/api/organizer/courses/:id/students', S.requireAuth('organizer'), wrap((req, res) => {
  const { student_id } = body(req, ['student_id']);
  db.prepare('INSERT OR IGNORE INTO enrollments(course_id,student_id,status,enrolled_at) VALUES (?,?,\'active\',?)')
    .run(req.params.id, student_id, S.nowISO());
  res.json({ ok: true });
}));

app.get('/api/organizer/sessions/:sid/attendance', S.requireAuth('organizer'), wrap((req, res) => {
  const rows = db.prepare(`SELECT a.*, u.name student_name FROM attendances a JOIN users u ON u.id=a.student_id
    WHERE a.session_id=? ORDER BY u.name`).all(req.params.sid);
  const logs = db.prepare('SELECT * FROM attendance_logs WHERE attendance_id IN (SELECT id FROM attendances WHERE session_id=?) ORDER BY id')
    .all(req.params.sid);
  res.json({ rows, logs });
}));

// 补签 / 修改考勤（含撤销补签恢复缺课）
app.post('/api/organizer/attendance/:aid/makeup', S.requireAuth('organizer'), wrap((req, res) => {
  const att = db.prepare(`SELECT a.* FROM attendances a JOIN sessions s ON s.id=a.session_id
    JOIN courses c ON c.id=s.course_id WHERE a.id=? AND c.organizer_id=?`).get(req.params.aid, req.user.uid);
  if (!att) throw new Error('考勤记录不存在');
  const { status, note } = req.body || {};
  if (!['present', 'late', 'absent', 'makeup'].includes(status)) throw new Error('状态非法');
  db.prepare('UPDATE attendances SET status=?, source=?, checked_at=?, note=? WHERE id=?')
    .run(status, status === 'makeup' ? 'makeup' : 'manual',
      (status === 'absent' ? null : (att.checked_at || S.nowISO())), note || '', att.id);
  S.logAttendance(att.id, status === 'absent' && att.status === 'makeup' ? 'revoke_makeup' : 'makeup',
    req.user, `主办方处理：${status}${note ? '；' + note : ''}`);
  res.json(db.prepare('SELECT * FROM attendances WHERE id=?').get(att.id));
}));

/* ---------------- 主办方：测验 ---------------- */
app.get('/api/organizer/sessions/:sid/quiz', S.requireAuth('organizer'), wrap((req, res) => {
  const q = db.prepare('SELECT * FROM quizzes WHERE session_id=?').get(req.params.sid);
  if (!q) return res.json(null);
  res.json({ ...q, questions: JSON.parse(q.questions_json) });
}));

app.put('/api/organizer/sessions/:sid/quiz', S.requireAuth('organizer'), wrap((req, res) => {
  const b = body(req, ['title', 'questions']);
  if (!Array.isArray(b.questions) || b.questions.length === 0) throw new Error('至少一道题');
  const json = JSON.stringify(b.questions.map(q => ({
    q: String(q.q || ''), options: q.options.map(String), answer: Number(q.answer), score: Number(q.score) || 10,
  })));
  const exist = db.prepare('SELECT id FROM quizzes WHERE session_id=?').get(req.params.sid);
  if (exist) {
    db.prepare('UPDATE quizzes SET title=?, questions_json=? WHERE id=?').run(b.title, json, exist.id);
    return res.json(db.prepare('SELECT * FROM quizzes WHERE id=?').get(exist.id));
  }
  const info = db.prepare('INSERT INTO quizzes(session_id,title,questions_json,created_at) VALUES (?,?,?,?)')
    .run(req.params.sid, b.title, json, S.nowISO());
  res.json(db.prepare('SELECT * FROM quizzes WHERE id=?').get(info.lastInsertRowid));
}));

app.get('/api/organizer/sessions/:sid/attempts', S.requireAuth('organizer'), wrap((req, res) => {
  res.json(db.prepare(`SELECT qa.*, u.name student_name FROM quiz_attempts qa JOIN users u ON u.id=qa.student_id
    WHERE qa.quiz_id IN (SELECT id FROM quizzes WHERE session_id=?) ORDER BY qa.id DESC`).all(req.params.sid));
}));

/* ---------------- 主办方：证书样式与证书管理 ---------------- */
app.get('/api/organizer/courses/:id/templates', S.requireAuth('organizer'), wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM certificate_templates WHERE course_id=? ORDER BY id').all(req.params.id));
}));

app.post('/api/organizer/courses/:id/templates', S.requireAuth('organizer'), wrap((req, res) => {
  const b = body(req, ['name']);
  const info = db.prepare('INSERT INTO certificate_templates(course_id,name,title_text,body_text,created_at) VALUES (?,?,?,?,?)')
    .run(req.params.id, b.name, b.title_text || '结业证书',
      b.body_text || '兹证明 {name} 已完成《{course}》全部课程，考勤与测验合格，特发此证。', S.nowISO());
  res.json(db.prepare('SELECT * FROM certificate_templates WHERE id=?').get(info.lastInsertRowid));
}));

app.get('/api/organizer/courses/:id/certificates', S.requireAuth('organizer'), wrap((req, res) => {
  res.json(db.prepare(`SELECT ce.*, u.name student_name FROM certificates ce JOIN users u ON u.id=ce.student_id
    WHERE ce.course_id=? ORDER BY ce.id DESC`).all(req.params.id));
}));

app.post('/api/organizer/courses/:id/issue', S.requireAuth('organizer'), wrap((req, res) => {
  const { student_id, template_id } = body(req, ['student_id']);
  res.json(S.issueCertificate(Number(req.params.id), student_id, req.user, template_id));
}));

app.post('/api/organizer/certificates/:cid/reissue', S.requireAuth('organizer'), wrap((req, res) => {
  const { reason } = body(req, ['reason']);
  if (!reason.trim()) throw new Error('补发必须填写原因');
  res.json(S.reissueCertificate(Number(req.params.cid), reason, req.user));
}));

app.post('/api/organizer/certificates/:cid/revoke', S.requireAuth('organizer'), wrap((req, res) => {
  const { reason } = body(req, ['reason']);
  const cert = db.prepare(`SELECT ce.* FROM certificates ce JOIN courses c ON c.id=ce.course_id
    WHERE ce.id=? AND c.organizer_id=?`).get(req.params.cid, req.user.uid);
  if (!cert) throw new Error('证书不存在');
  if (cert.status !== 'valid') throw new Error('仅有效证书可吊销');
  db.prepare(`UPDATE certificates SET status='revoked', invalid_reason=? WHERE id=?`)
    .run(`吊销：${reason || '违规'}`, cert.id);
  res.json(db.prepare('SELECT * FROM certificates WHERE id=?').get(cert.id));
}));

/* ---------------- 学员端 ---------------- */
app.get('/api/student/catalog', S.requireAuth('student'), wrap((req, res) => {
  const rows = db.prepare(`SELECT c.id,c.title,c.description,u.name organizer_name,
    EXISTS(SELECT 1 FROM enrollments e WHERE e.course_id=c.id AND e.student_id=? AND e.status='active') enrolled
    FROM courses c JOIN users u ON u.id=c.organizer_id ORDER BY c.id DESC`).all(req.user.uid);
  res.json(rows);
}));

app.post('/api/student/courses/:id/enroll', S.requireAuth('student'), wrap((req, res) => {
  db.prepare('INSERT OR IGNORE INTO enrollments(course_id,student_id,status,enrolled_at) VALUES (?,?,\'active\',?)')
    .run(req.params.id, req.user.uid, S.nowISO());
  res.json({ ok: true });
}));

app.get('/api/student/courses', S.requireAuth('student'), wrap((req, res) => {
  const courses = db.prepare(`SELECT c.* FROM enrollments e JOIN courses c ON c.id=e.course_id
    WHERE e.student_id=? AND e.status='active' ORDER BY c.id DESC`).all(req.user.uid);
  res.json(courses.map(c => ({ ...c, progress: S.getProgress(c.id, req.user.uid) })));
}));

app.get('/api/student/sessions/:sid', S.requireAuth('student'), wrap((req, res) => {
  const ses = db.prepare(`SELECT s.*, e.id eid FROM sessions s JOIN enrollments e ON e.course_id=s.course_id AND e.status='active'
    WHERE s.id=? AND e.student_id=?`).get(req.params.sid, req.user.uid);
  if (!ses) throw new Error('课次不存在或未报名');
  const att = db.prepare('SELECT * FROM attendances WHERE session_id=? AND student_id=?').get(req.params.sid, req.user.uid);
  const quiz = db.prepare('SELECT * FROM quizzes WHERE session_id=?').get(req.params.sid);
  let quizInfo = null, myBest = null;
  if (quiz) {
    quizInfo = { id: quiz.id, title: quiz.title, questions: JSON.parse(quiz.questions_json) };
    const r = db.prepare('SELECT MAX(score) m FROM quiz_attempts WHERE quiz_id=? AND student_id=?').get(quiz.id, req.user.uid);
    myBest = r.m;
  }
  res.json({ session: ses, attendance: att || null, quiz: quizInfo, myBest });
}));

// 扫码签到
app.post('/api/student/checkin', S.requireAuth('student'), wrap((req, res) => {
  const { code } = body(req, ['code']);
  const c = db.prepare('SELECT * FROM codes WHERE code=?').get(String(code).trim().toUpperCase());
  if (!c) throw new Error('签到码无效');
  if (!c.active) throw new Error('该签到码已停用');
  const now = Date.now();
  if (now < new Date(c.valid_from).getTime()) throw new Error('签到尚未开始');
  if (now > new Date(c.valid_until).getTime()) throw new Error('签到已结束，如需补签请联系主办方');
  const ses = db.prepare('SELECT * FROM sessions WHERE id=?').get(c.session_id);
  const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE course_id=? AND student_id=? AND status=\'active\'')
    .get(ses.course_id, req.user.uid);
  if (!enrolled) throw new Error('您未报名该课程');
  const exist = db.prepare('SELECT * FROM attendances WHERE session_id=? AND student_id=?').get(c.session_id, req.user.uid);
  if (exist) throw new Error(`您已签到（状态：${{present:'正常',late:'迟到',makeup:'补签',absent:'缺课'}[exist.status]}）`);
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(ses.course_id);
  const late = now > new Date(ses.start_time).getTime() + course.late_grace_min * 60000;
  const status = late ? 'late' : 'present';
  const info = db.prepare(`INSERT INTO attendances(session_id,student_id,status,source,checked_at,note)
    VALUES (?,?,?,'scan',?,?)`).run(c.session_id, req.user.uid, status, S.nowISO(),
    late ? `超过开课后宽限 ${course.late_grace_min} 分钟` : '');
  S.logAttendance(info.lastInsertRowid, 'scan', req.user, late ? '扫码签到：迟到' : '扫码签到：正常');
  res.json({ status, session_title: ses.title });
}));

// 提交测验（可重复提交取最高分）
app.post('/api/student/quizzes/:qid/submit', S.requireAuth('student'), wrap((req, res) => {
  const { answers } = body(req, ['answers']);
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id=?').get(req.params.qid);
  if (!quiz) throw new Error('测验不存在');
  const enrolled = db.prepare(`SELECT 1 FROM sessions s JOIN enrollments e ON e.course_id=s.course_id
    WHERE s.id=? AND e.student_id=? AND e.status='active'`).get(quiz.session_id, req.user.uid);
  if (!enrolled) throw new Error('未报名该课程');
  const questions = JSON.parse(quiz.questions_json);
  let score = 0;
  questions.forEach((q, i) => { if (Number(answers[i]) === q.answer) score += q.score; });
  db.prepare('INSERT INTO quiz_attempts(quiz_id,student_id,score,answers_json,submitted_at) VALUES (?,?,?,?,?)')
    .run(quiz.id, req.user.uid, score, JSON.stringify(answers), S.nowISO());
  const best = db.prepare('SELECT MAX(score) m FROM quiz_attempts WHERE quiz_id=? AND student_id=?').get(quiz.id, req.user.uid).m;
  res.json({ score, best });
}));

app.get('/api/student/certificates', S.requireAuth('student'), wrap((req, res) => {
  res.json(db.prepare(`SELECT ce.*, c.title course_title FROM certificates ce JOIN courses c ON c.id=ce.course_id
    WHERE ce.student_id=? ORDER BY ce.id DESC`).all(req.user.uid));
}));

app.get('/api/student/courses/:id/progress', S.requireAuth('student'), wrap((req, res) => {
  const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE course_id=? AND student_id=? AND status=\'active\'')
    .get(req.params.id, req.user.uid);
  if (!enrolled) throw new Error('未报名该课程');
  res.json(S.getProgress(Number(req.params.id), req.user.uid));
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`培训签到证书平台已启动: http://localhost:${PORT}`));
