const express = require('express');
const QRCode = require('qrcode');
const { db, nowISO, audit } = require('../db');
const { authRequired, organizerOnly } = require('../auth');
const svc = require('../services');

const router = express.Router();
router.use(authRequired, organizerOnly);

function ownedCourse(id, userId) {
  const c = db.prepare('SELECT * FROM courses WHERE id=?').get(id);
  if (!c) return { error: 404 };
  if (c.organizer_id !== userId) return { error: 403 };
  return { course: c };
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    res.status(e.status || 500).json({ error: e.message || '服务器错误' });
  });
}

/* ---------- 仪表盘 ---------- */
router.get('/dashboard', (req, res) => {
  const uid = req.user.id;
  sweep();
  const courses = db.prepare(`
    SELECT c.*, COUNT(DISTINCT e.id) AS student_count, COUNT(DISTINCT s.id) AS session_count
    FROM courses c LEFT JOIN enrollments e ON e.course_id=c.id
    LEFT JOIN sessions s ON s.course_id=c.id
    WHERE c.organizer_id=? GROUP BY c.id ORDER BY c.id DESC`).all(uid);
  const pendingMakeups = db.prepare(`
    SELECT m.*, u.name AS student_name, c.title AS course_title, se.title AS session_title
    FROM makeup_requests m JOIN users u ON u.id=m.student_id
    JOIN attendances a ON a.id=m.attendance_id
    JOIN sessions se ON se.id=a.session_id
    JOIN courses c ON c.id=se.course_id
    WHERE c.organizer_id=? AND m.status='pending' ORDER BY m.id DESC`).all(uid);
  const issued = db.prepare(`SELECT COUNT(*) c FROM certificates WHERE course_id IN
    (SELECT id FROM courses WHERE organizer_id=?)`).get(uid).c;
  const invalid = db.prepare(`SELECT COUNT(*) c FROM certificates WHERE status='invalidated' AND course_id IN
    (SELECT id FROM courses WHERE organizer_id=?)`).get(uid).c;
  res.json({ courses, pendingMakeups, issued, invalid });
});

function sweep() { svc.sweepAbsences(null); }

/* ---------- 课程 ---------- */
router.post('/courses', (req, res) => {
  const { title, description = '', minAttendanceRatio = 0.8, passScore = 60 } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '课程名称必填' });
  const ratio = Number(minAttendanceRatio);
  const score = parseInt(passScore, 10);
  if (!(ratio > 0 && ratio <= 1)) return res.status(400).json({ error: '出勤率门槛需在 0~1 之间' });
  if (!(score > 0 && score <= 100)) return res.status(400).json({ error: '合格分数线需在 1~100 之间' });
  const info = db.prepare(`INSERT INTO courses
    (title,description,organizer_id,min_attendance_ratio,pass_score,created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(String(title).trim(), description, req.user.id, ratio, score, nowISO());
  audit({ courseId: info.lastInsertRowid, actor: req.user, action: 'course_created',
    entityType: 'course', entityId: info.lastInsertRowid, detail: { title } });
  res.status(201).json(db.prepare('SELECT * FROM courses WHERE id=?').get(info.lastInsertRowid));
});

router.put('/courses/:id', (req, res) => {
  const { error, course } = ownedCourse(req.params.id, req.user.id);
  if (error) return res.status(error).json({ error: error === 404 ? '课程不存在' : '无权操作' });
  const { title, description, minAttendanceRatio, passScore, status } = req.body || {};
  db.prepare(`UPDATE courses SET
    title=COALESCE(?,title), description=COALESCE(?,description),
    min_attendance_ratio=COALESCE(?,min_attendance_ratio),
    pass_score=COALESCE(?,pass_score), status=COALESCE(?,status)
    WHERE id=?`).run(
      title ?? null, description ?? null,
      minAttendanceRatio != null ? Number(minAttendanceRatio) : null,
      passScore != null ? parseInt(passScore, 10) : null,
      status ?? null, course.id);
  audit({ courseId: course.id, actor: req.user, action: 'course_updated', entityType: 'course', entityId: course.id, detail: req.body });
  res.json(db.prepare('SELECT * FROM courses WHERE id=?').get(course.id));
});

/* ---------- 课次 ---------- */
router.get('/courses/:id', (req, res) => {
  sweep();
  const { error, course } = ownedCourse(req.params.id, req.user.id);
  if (error) return res.status(error).json({ error: error === 404 ? '课程不存在' : '无权操作' });
  const sessions = db.prepare('SELECT * FROM sessions WHERE course_id=? ORDER BY start_at').all(course.id)
    .map((s) => ({ ...s, ...svc.sessionLiveState(s), code: svc.activeCodeForSession(s.id) || null }));
  const template = db.prepare('SELECT * FROM certificate_templates WHERE course_id=?').get(course.id) || null;
  const quiz = db.prepare('SELECT * FROM quizzes WHERE course_id=?').get(course.id);
  let questions = null;
  if (quiz) questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY seq').all(quiz.id);
  res.json({ course, sessions, template, quiz: quiz ? { ...quiz, questions } : null,
    roster: svc.courseRoster(course.id) });
});

router.post('/courses/:id/sessions', (req, res) => {
  const { error, course } = ownedCourse(req.params.id, req.user.id);
  if (error) return res.status(error).json({ error: error === 404 ? '课程不存在' : '无权操作' });
  const { title, startAt, durationMin = 90, lateGraceMin = 10, openBeforeMin = 30, closeAfterMin = 60 } = req.body || {};
  if (!title || !startAt) return res.status(400).json({ error: '课次名称和开始时间必填' });
  const t = new Date(startAt);
  if (isNaN(t)) return res.status(400).json({ error: '开始时间格式无效' });
  const info = db.prepare(`INSERT INTO sessions
    (course_id,title,start_at,duration_min,late_grace_min,open_before_min,close_after_min,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(course.id, String(title).trim(), t.toISOString(),
    parseInt(durationMin, 10), parseInt(lateGraceMin, 10), parseInt(openBeforeMin, 10),
    parseInt(closeAfterMin, 10), nowISO());
  const sessionId = info.lastInsertRowid;
  const code = svc.rotateSigninCode(sessionId, req.user);
  audit({ courseId: course.id, actor: req.user, action: 'session_created', entityType: 'session',
    entityId: sessionId, detail: { title, startAt: t.toISOString(), code } });
  res.status(201).json(db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId));
});

router.post('/sessions/:sid/rotate-code', wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.params.sid);
  if (!s) return res.status(404).json({ error: '课次不存在' });
  const { error } = ownedCourse(s.course_id, req.user.id);
  if (error) return res.status(error).json({ error: '无权操作' });
  const code = svc.rotateSigninCode(s.id, req.user);
  const payload = JSON.stringify({ t: 'checkin', c: code, sid: s.id });
  const qrDataUrl = await QRCode.toDataURL(payload, { width: 320, margin: 1 });
  res.json({ code, qrDataUrl });
}));

router.get('/sessions/:sid/qr', wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.params.sid);
  if (!s) return res.status(404).json({ error: '课次不存在' });
  const { error } = ownedCourse(s.course_id, req.user.id);
  if (error) return res.status(error).json({ error: '无权操作' });
  let codeRow = svc.activeCodeForSession(s.id);
  if (!codeRow) {
    const code = svc.rotateSigninCode(s.id, req.user);
    codeRow = svc.activeCodeForSession(s.id);
  }
  const payload = JSON.stringify({ t: 'checkin', c: codeRow.code, sid: s.id });
  const qrDataUrl = await QRCode.toDataURL(payload, { width: 320, margin: 1 });
  res.json({ code: codeRow.code, qrDataUrl });
}));

/* 课次考勤明细 + 手动改状态 */
router.get('/sessions/:sid/attendance', (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.params.sid);
  if (!s) return res.status(404).json({ error: '课次不存在' });
  const { error } = ownedCourse(s.course_id, req.user.id);
  if (error) return res.status(error).json({ error: '无权操作' });
  svc.sweepAbsences(null);
  const rows = db.prepare(`
    SELECT u.id AS student_id, u.name, u.phone, a.id AS attendance_id,
      a.status, a.signed_at, a.note
    FROM enrollments e JOIN users u ON u.id=e.student_id
    LEFT JOIN attendances a ON a.session_id=? AND a.student_id=u.id
    WHERE e.course_id=? ORDER BY u.name`).all(s.id, s.course_id);
  res.json({ session: s, rows });
});

/* ---------- 报名 / 学员 ---------- */
router.get('/students', (req, res) => {
  const students = db.prepare("SELECT id,name,phone FROM users WHERE role='student' ORDER BY id").all();
  res.json(students);
});

router.post('/courses/:id/enroll', (req, res) => {
  const { error, course } = ownedCourse(req.params.id, req.user.id);
  if (error) return res.status(error).json({ error: error === 404 ? '课程不存在' : '无权操作' });
  let student;
  if (req.body.studentId) {
    student = db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(req.body.studentId);
  } else if (req.body.phone) {
    student = db.prepare("SELECT * FROM users WHERE phone=? AND role='student'").get(String(req.body.phone).trim());
  }
  if (!student) return res.status(404).json({ error: '未找到该学员' });
  try {
    db.prepare('INSERT INTO enrollments (course_id,student_id,enrolled_at) VALUES (?,?,?)')
      .run(course.id, student.id, nowISO());
  } catch (e) {
    return res.status(409).json({ error: '该学员已报名' });
  }
  audit({ courseId: course.id, actor: req.user, action: 'student_enrolled', entityType: 'student',
    entityId: student.id, detail: { name: student.name } });
  res.status(201).json({ ok: true });
});

/* ---------- 补签审批 ---------- */
router.get('/makeup-requests', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, u.name AS student_name, c.id AS course_id, c.title AS course_title,
      se.title AS session_title, se.start_at
    FROM makeup_requests m JOIN users u ON u.id=m.student_id
    JOIN attendances a ON a.id=m.attendance_id
    JOIN sessions se ON se.id=a.session_id
    JOIN courses c ON c.id=se.course_id
    WHERE c.organizer_id=? ORDER BY
      CASE m.status WHEN 'pending' THEN 0 ELSE 1 END, m.id DESC`).all(req.user.id);
  res.json(rows);
});

function reviewMakeup(req, res, approve) {
  const m = db.prepare('SELECT * FROM makeup_requests WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '申请不存在' });
  const att = db.prepare('SELECT * FROM attendances WHERE id=?').get(m.attendance_id);
  const { error } = ownedCourse(
    db.prepare('SELECT course_id FROM sessions WHERE id=?').get(att.session_id).course_id,
    req.user.id);
  if (error) return res.status(error).json({ error: '无权操作' });
  if (m.status !== 'pending') return res.status(409).json({ error: '该申请已处理' });

  if (approve) {
    const note = `补签批准：${m.reason}` + (req.body?.reviewNote ? `（${req.body.reviewNote}）` : '');
    db.prepare("UPDATE attendances SET status='makeup', note=?, updated_at=? WHERE id=?")
      .run(note, nowISO(), att.id);
    db.prepare("UPDATE makeup_requests SET status='approved', reviewed_by=?, review_note=?, reviewed_at=? WHERE id=?")
      .run(req.user.id, req.body?.reviewNote || '', nowISO(), m.id);
    audit({ courseId: db.prepare('SELECT course_id FROM sessions WHERE id=?').get(att.session_id).course_id,
      actor: req.user, action: 'makeup_approved', entityType: 'makeup_request', entityId: m.id,
      detail: { studentId: m.student_id, reason: m.reason } });
  } else {
    db.prepare("UPDATE makeup_requests SET status='rejected', reviewed_by=?, review_note=?, reviewed_at=? WHERE id=?")
      .run(req.user.id, req.body?.reviewNote || '', nowISO(), m.id);
    audit({ courseId: db.prepare('SELECT course_id FROM sessions WHERE id=?').get(att.session_id).course_id,
      actor: req.user, action: 'makeup_rejected', entityType: 'makeup_request', entityId: m.id,
      detail: { studentId: m.student_id, reason: m.reason, reviewNote: req.body?.reviewNote || '' } });
  }
  res.json(db.prepare('SELECT * FROM makeup_requests WHERE id=?').get(m.id));
}
router.post('/makeup-requests/:id/approve', (req, res) => reviewMakeup(req, res, true));
router.post('/makeup-requests/:id/reject', (req, res) => reviewMakeup(req, res, false));

/* ---------- 测验 ---------- */
router.put('/courses/:id/quiz', (req, res) => {
  const { error, course } = ownedCourse(req.params.id, req.user.id);
  if (error) return res.status(error).json({ error: error === 404 ? '课程不存在' : '无权操作' });
  const { title, questions } = req.body || {};
  if (!title || !Array.isArray(questions) || questions.length === 0)
    return res.status(400).json({ error: '测验标题和题目必填' });
  for (const q of questions) {
    if (!q.text || !Array.isArray(q.options) || q.options.length < 2)
      return res.status(400).json({ error: '每道题至少 2 个选项' });
    if (!(Number(q.correctIndex) >= 0 && Number(q.correctIndex) < q.options.length))
      return res.status(400).json({ error: '正确答案索引无效' });
  }
  const tx = db.transaction(() => {
    let quiz = db.prepare('SELECT * FROM quizzes WHERE course_id=?').get(course.id);
    if (quiz) {
      db.prepare('UPDATE quizzes SET title=? WHERE id=?').run(title, quiz.id);
      db.prepare('DELETE FROM questions WHERE quiz_id=?').run(quiz.id);
    } else {
      const info = db.prepare('INSERT INTO quizzes (course_id,title,created_at) VALUES (?,?,?)')
        .run(course.id, title, nowISO());
      quiz = db.prepare('SELECT * FROM quizzes WHERE id=?').get(info.lastInsertRowid);
    }
    const ins = db.prepare('INSERT INTO questions (quiz_id,seq,text,options_json,correct_index,score) VALUES (?,?,?,?,?,?)');
    questions.forEach((q, i) => ins.run(quiz.id, i + 1, q.text, JSON.stringify(q.options),
      Number(q.correctIndex), Number(q.score) || Math.round(100 / questions.length)));
  });
  tx();
  audit({ courseId: course.id, actor: req.user, action: 'quiz_saved', entityType: 'quiz',
    entityId: course.id, detail: { title, count: questions.length } });
  res.json({ ok: true });
});

/* ---------- 证书样式 ---------- */
router.put('/courses/:id/template', (req, res) => {
  const { error, course } = ownedCourse(req.params.id, req.user.id);
  if (error) return res.status(error).json({ error: error === 404 ? '课程不存在' : '无权操作' });
  const f = req.body || {};
  if (!f.orgName || !f.title || !f.signerName)
    return res.status(400).json({ error: '发证机构、证书标题、签发人为必填' });
  const existing = db.prepare('SELECT id FROM certificate_templates WHERE course_id=?').get(course.id);
  if (existing) {
    db.prepare(`UPDATE certificate_templates SET org_name=?,title=?,subtitle=?,signer_name=?,
      signer_title=?,accent_color=?,updated_at=? WHERE course_id=?`).run(
      f.orgName, f.title, f.subtitle || '', f.signerName, f.signerTitle || '',
      f.accentColor || '#1d4ed8', nowISO(), course.id);
  } else {
    db.prepare(`INSERT INTO certificate_templates
      (course_id,org_name,title,subtitle,signer_name,signer_title,accent_color,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(course.id, f.orgName, f.title, f.subtitle || '',
      f.signerName, f.signerTitle || '', f.accentColor || '#1d4ed8', nowISO());
  }
  audit({ courseId: course.id, actor: req.user, action: 'template_saved', entityType: 'certificate_template',
    entityId: course.id });
  res.json({ ok: true });
});

/* ---------- 发证 / 批量 / 作废 / 补发 ---------- */
router.post('/courses/:id/certificates/issue', wrap((req, res) => {
  const { error, course } = ownedCourse(req.params.id, req.user.id);
  if (error) return res.status(error).json({ error: error === 404 ? '课程不存在' : '无权操作' });
  const ids = req.body.studentIds || [];
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请选择学员' });
  const issued = [], skipped = [];
  for (const sid of ids) {
    try {
      issued.push(svc.issueCertificate({ courseId: course.id, studentId: sid, actor: req.user }));
    } catch (e) {
      skipped.push({ studentId: sid, reason: e.message });
    }
  }
  res.json({ issued: issued.map(c => ({ id: c.id, certNo: c.cert_no, studentId: c.student_id })), skipped });
}));

router.post('/certificates/:certId/invalidate', wrap((req, res) => {
  const cert = db.prepare('SELECT * FROM certificates WHERE id=?').get(req.params.certId);
  if (!cert) return res.status(404).json({ error: '证书不存在' });
  const { error } = ownedCourse(cert.course_id, req.user.id);
  if (error) return res.status(error).json({ error: '无权操作' });
  const updated = svc.invalidateCertificate({ certId: cert.id, actor: req.user,
    reason: (req.body.reason || '').trim() });
  res.json(updated);
}));

router.post('/certificates/:certId/reissue', wrap((req, res) => {
  const old = db.prepare('SELECT * FROM certificates WHERE id=?').get(req.params.certId);
  if (!old) return res.status(404).json({ error: '证书不存在' });
  const { error } = ownedCourse(old.course_id, req.user.id);
  if (error) return res.status(error).json({ error: '无权操作' });
  const reason = (req.body.reason || '').trim() || '证书信息更正补发';
  // 补发：旧证须已失效；未失效则按“换发”先自动失效
  let base = old;
  if (old.status === 'valid') {
    base = svc.invalidateCertificate({ certId: old.id, actor: req.user, reason: `换发自动作废：${reason}` });
  }
  const cert = svc.issueCertificate({ courseId: old.course_id, studentId: old.student_id,
    actor: req.user, reason: 'reissue', supersedesId: base.id, extraDetail: { reason } });
  res.status(201).json(cert);
}));

/* 课程下全部证书（含失效链） */
router.get('/courses/:id/certificates', (req, res) => {
  const { error, course } = ownedCourse(req.params.id, req.user.id);
  if (error) return res.status(error).json({ error: error === 404 ? '课程不存在' : '无权操作' });
  const rows = db.prepare(`
    SELECT ce.*, u.name AS student_name FROM certificates ce
    JOIN users u ON u.id=ce.student_id WHERE ce.course_id=?
    ORDER BY u.name, ce.id`).all(course.id);
  res.json(rows);
});

/* ---------- 审计 ---------- */
router.get('/audit', (req, res) => {
  const courseId = req.query.courseId;
  let rows;
  if (courseId) {
    rows = db.prepare(`SELECT a.* FROM audit_events a WHERE a.course_id=? ORDER BY a.id DESC LIMIT 300`).all(courseId);
  } else {
    rows = db.prepare(`SELECT a.* FROM audit_events a
      WHERE a.course_id IN (SELECT id FROM courses WHERE organizer_id=?)
      ORDER BY a.id DESC LIMIT 300`).all(req.user.id);
  }
  res.json(rows);
});

module.exports = router;
