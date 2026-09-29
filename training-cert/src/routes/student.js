const express = require('express');
const { db, nowISO, audit } = require('../db');
const { authRequired } = require('../auth');
const svc = require('../services');

const router = express.Router();
router.use(authRequired);

function studentOnly(req, res, next) {
  if (req.user.role !== 'student') return res.status(403).json({ error: '仅学员可用' });
  next();
}

/* ---------- 签到 ---------- */
router.post('/checkin', studentOnly, (req, res) => {
  svc.sweepAbsences(null);
  const result = svc.checkin({ student: req.user, code: (req.body || {}).code });
  if (!result.ok) return res.status(result.status).json({ error: result.message });
  res.json({ ok: true, ...result });
});

/* ---------- 我的课程 ---------- */
router.get('/my/courses', studentOnly, (req, res) => {
  svc.sweepAbsences(null);
  const rows = db.prepare(`
    SELECT c.*, u.name AS organizer_name FROM enrollments e
    JOIN courses c ON c.id=e.course_id JOIN users u ON u.id=c.organizer_id
    WHERE e.student_id=? ORDER BY c.id DESC`).all(req.user.id);
  const out = rows.map((c) => {
    const att = svc.attendanceSummary(c.id, req.user.id);
    const qz = svc.bestQuizScore(c.id, req.user.id);
    const sessions = db.prepare(`
      SELECT s.id, s.title, s.start_at, s.duration_min, s.late_grace_min,
             s.open_before_min, s.close_after_min, a.status AS att_status,
             a.signed_at, a.note AS att_note
      FROM sessions s LEFT JOIN attendances a ON a.session_id=s.id AND a.student_id=?
      WHERE s.course_id=? ORDER BY s.start_at`).all(req.user.id, c.id).map((s) => ({
        id: s.id, title: s.title, start_at: s.start_at,
        status: s.att_status, signed_at: s.signed_at, note: s.att_note,
        ...svc.sessionLiveState(s),
        makeupRequest: db.prepare('SELECT id,status,reason FROM makeup_requests WHERE attendance_id IN (SELECT id FROM attendances WHERE session_id=? AND student_id=?) ORDER BY id DESC LIMIT 1').get(s.id, req.user.id) || null,
      }));
    const certs = db.prepare('SELECT * FROM certificates WHERE course_id=? AND student_id=? ORDER BY id')
      .all(c.id, req.user.id);
    const validCert = certs.find(x => x.status === 'valid') || null;
    const eligible = att.passedAttendance && qz.passedQuiz;
    const reasons = [];
    if (!att.passedAttendance) reasons.push('出勤率未达标');
    if (!qz.passedQuiz) reasons.push(qz.best == null ? '尚未通过测验' : '测验未达合格线');
    return { ...c, attendance: att, quiz: { best: qz.best, attempts: qz.attempts, passed: qz.passedQuiz,
      passScore: c.pass_score }, sessions, eligible, ineligibleReason: reasons.join('，'),
      validCert, certHistory: certs };
  });
  res.json(out);
});

/* 可报名课程 */
router.get('/available-courses', studentOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id,c.title,c.description,c.min_attendance_ratio,c.pass_score,u.name AS organizer_name
    FROM courses c JOIN users u ON u.id=c.organizer_id
    WHERE c.status='active' AND c.id NOT IN (SELECT course_id FROM enrollments WHERE student_id=?)
    ORDER BY c.id DESC`).all(req.user.id);
  res.json(rows);
});

router.post('/courses/:id/enroll-self', studentOnly, (req, res) => {
  const c = db.prepare("SELECT * FROM courses WHERE id=? AND status='active'").get(req.params.id);
  if (!c) return res.status(404).json({ error: '课程不存在或已关闭' });
  try {
    db.prepare('INSERT INTO enrollments (course_id,student_id,enrolled_at) VALUES (?,?,?)')
      .run(c.id, req.user.id, nowISO());
  } catch (e) {
    return res.status(409).json({ error: '已经报名' });
  }
  audit({ courseId: c.id, actor: req.user, action: 'student_self_enrolled', entityType: 'student', entityId: req.user.id });
  res.status(201).json({ ok: true });
});

/* ---------- 补签申请 ---------- */
router.post('/sessions/:sid/makeup', studentOnly, (req, res) => {
  const sid = req.params.sid;
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
  if (!s) return res.status(404).json({ error: '课次不存在' });
  const enr = db.prepare('SELECT 1 FROM enrollments WHERE course_id=? AND student_id=?')
    .get(s.course_id, req.user.id);
  if (!enr) return res.status(403).json({ error: '你未报名该课程' });
  let att = db.prepare('SELECT * FROM attendances WHERE session_id=? AND student_id=?')
    .get(sid, req.user.id);
  // 窗口已关仍无记录：先落一条 absent，再允许申请补签
  if (!att) {
    const live = svc.sessionLiveState(s);
    if (live.state !== 'closed')
      return res.status(400).json({ error: live.state === 'open' ? '签到窗口仍开放，请直接签到' : '课次尚未开始' });
    db.prepare("INSERT INTO attendances (session_id,student_id,status,note,updated_at) VALUES (?,?, 'absent','系统自动标记',?)")
      .run(sid, req.user.id, nowISO());
    att = db.prepare('SELECT * FROM attendances WHERE session_id=? AND student_id=?').get(sid, req.user.id);
  }
  if (att.status === 'present' || att.status === 'late')
    return res.status(400).json({ error: '你本次考勤为正常/迟到，无需补签' });
  if (att.status === 'makeup')
    return res.status(400).json({ error: '该课次已补签通过' });
  const pending = db.prepare("SELECT 1 FROM makeup_requests WHERE attendance_id=? AND status='pending'").get(att.id);
  if (pending) return res.status(409).json({ error: '已提交补签申请，等待审核' });
  const reason = (req.body?.reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ error: '请填写不少于 5 个字的缺课原因' });
  db.prepare('INSERT INTO makeup_requests (attendance_id,student_id,reason,created_at) VALUES (?,?,?,?)')
    .run(att.id, req.user.id, reason, nowISO());
  audit({ courseId: s.course_id, actor: req.user, action: 'makeup_requested',
    entityType: 'session', entityId: s.id, detail: { reason } });
  res.status(201).json({ ok: true });
});

/* ---------- 测验 ---------- */
router.get('/courses/:id/quiz', studentOnly, (req, res) => {
  const cid = req.params.id;
  const enr = db.prepare('SELECT 1 FROM enrollments WHERE course_id=? AND student_id=?').get(cid, req.user.id);
  if (!enr) return res.status(403).json({ error: '你未报名该课程' });
  const quiz = db.prepare('SELECT id,title,course_id FROM quizzes WHERE course_id=?').get(cid);
  if (!quiz) return res.status(404).json({ error: '该课程尚未发布测验' });
  const questions = db.prepare('SELECT id,seq,text,options_json,score FROM questions WHERE quiz_id=? ORDER BY seq').all(quiz.id)
    .map(q => ({ ...q, options: JSON.parse(q.options_json) }));
  const attempts = db.prepare('SELECT id,score,created_at FROM quiz_attempts WHERE quiz_id=? AND student_id=? ORDER BY id DESC')
    .all(quiz.id, req.user.id);
  res.json({ ...quiz, questions, passScore: db.prepare('SELECT pass_score FROM courses WHERE id=?').get(cid).pass_score, attempts });
});

router.post('/courses/:id/quiz/submit', studentOnly, (req, res) => {
  const cid = req.params.id;
  const enr = db.prepare('SELECT 1 FROM enrollments WHERE course_id=? AND student_id=?').get(cid, req.user.id);
  if (!enr) return res.status(403).json({ error: '你未报名该课程' });
  const quiz = db.prepare('SELECT * FROM quizzes WHERE course_id=?').get(cid);
  if (!quiz) return res.status(404).json({ error: '测验不存在' });
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY seq').all(quiz.id);
  const answers = req.body?.answers || {};
  let score = 0;
  const details = questions.map((q) => {
    const given = Number(answers[q.id]);
    const correct = given === q.correct_index;
    if (correct) score += q.score;
    return { questionId: q.id, given, correct: q.correct_index, ok: correct };
  });
  db.prepare('INSERT INTO quiz_attempts (quiz_id,student_id,score,answers_json,created_at) VALUES (?,?,?,?,?)')
    .run(quiz.id, req.user.id, score, JSON.stringify({ details }), nowISO());
  const pass = score >= db.prepare('SELECT pass_score FROM courses WHERE id=?').get(cid).pass_score;
  audit({ courseId: cid, actor: req.user, action: 'quiz_submitted', entityType: 'quiz', entityId: quiz.id,
    detail: { score, passed: pass } });
  res.status(201).json({ score, pass, details });
});

/* ---------- 证书 ---------- */
router.get('/my/certificates', studentOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT ce.*, c.title AS course_title, c.pass_score, c.min_attendance_ratio
    FROM certificates ce JOIN courses c ON c.id=ce.course_id
    WHERE ce.student_id=? ORDER BY ce.id DESC`).all(req.user.id);
  const withChain = rows.map((ce) => ({ ...ce, chain: svc.certChain(ce).map(x => ({
    id: x.id, certNo: x.cert_no, status: x.status, issueReason: x.issue_reason,
    invalidateReason: x.invalidate_reason, createdAt: x.created_at, invalidatedAt: x.invalidated_at,
  })) }));
  res.json(withChain);
});

module.exports = router;
