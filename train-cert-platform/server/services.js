const crypto = require('crypto');
const db = require('./db');

const nowISO = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');

const tokenStore = new Map(); // token -> {uid, role, name}
function createToken(user) {
  const token = crypto.randomBytes(24).toString('hex');
  tokenStore.set(token, { uid: user.id, role: user.role, name: user.name });
  return token;
}
function getUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  return tokenStore.get(token) || null;
}
function requireAuth(role) {
  return (req, res, next) => {
    const u = getUser(req);
    if (!u) return res.status(401).json({ error: '未登录或登录已失效' });
    if (role && u.role !== role) return res.status(403).json({ error: '无权限' });
    req.user = u;
    next();
  };
}

function logAttendance(attendanceId, action, actor, detail) {
  db.prepare(`INSERT INTO attendance_logs(attendance_id, action, actor_id, actor_name, detail, created_at)
              VALUES (?,?,?,?,?,?)`).run(attendanceId, action, actor ? actor.uid : null,
    actor ? actor.name : '系统', detail || '', nowISO());
}

// 把某课次未签到学员记为缺课（幂等：已有记录不动）
function settleSession(sessionId, actor) {
  const ses = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  if (!ses) throw new Error('课次不存在');
  const students = db.prepare(`SELECT e.student_id FROM enrollments e
    WHERE e.course_id=? AND e.status='active'`).all(ses.course_id);
  const existing = new Set(db.prepare('SELECT student_id FROM attendances WHERE session_id=?')
    .all(sessionId).map(r => r.student_id));
  const insert = db.prepare(`INSERT INTO attendances(session_id,student_id,status,source,checked_at,note)
    VALUES (?,?, 'absent','manual', NULL, '课次结束后系统结算缺课')`);
  let settled = 0;
  for (const s of students) {
    if (!existing.has(s.student_id)) {
      const info = insert.run(sessionId, s.student_id);
      logAttendance(info.lastInsertRowid, 'settle', actor || null, '自动标记缺课');
      settled++;
    }
  }
  return settled;
}

// 汇总学员在某课程的考勤 / 测验情况
function getProgress(courseId, studentId) {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
  const sessions = db.prepare('SELECT * FROM sessions WHERE course_id=? ORDER BY start_time').all(courseId);
  const atts = db.prepare(`SELECT s.id session_id, s.title, s.start_time, a.status, a.source, a.checked_at, a.note
    FROM sessions s LEFT JOIN attendances a ON a.session_id=s.id AND a.student_id=?
    WHERE s.course_id=? ORDER BY s.start_time`).all(studentId, courseId);
  let present = 0, late = 0, absent = 0, makeup = 0, pending = 0;
  const rows = atts.map(a => {
    const st = a.status || 'pending';
    if (st === 'present') present++;
    else if (st === 'late') late++;
    else if (st === 'absent') absent++;
    else if (st === 'makeup') makeup++;
    else pending++;
    return { ...a, status: st };
  });
  // 每个测验取最高分
  const quizRows = db.prepare(`SELECT q.id, q.title, MAX(qa.score) score
    FROM quizzes q LEFT JOIN quiz_attempts qa ON qa.quiz_id=q.id AND qa.student_id=?
    WHERE q.id IN (SELECT id FROM quizzes WHERE session_id IN
      (SELECT id FROM sessions WHERE course_id=?))
    GROUP BY q.id`).all(studentId, courseId);
  const quizzes = quizRows.map(q => ({ ...q, score: q.score ?? null }));
  const quizTaken = quizzes.filter(q => q.score !== null);
  const avg = quizTaken.length
    ? Math.round(quizTaken.reduce((s, q) => s + q.score, 0) / quizTaken.length) : null;

  const reasons = [];
  const allSettled = pending === 0;
  if (absent > course.absence_limit) reasons.push(`缺课 ${absent} 次，超过允许上限 ${course.absence_limit} 次`);
  if (late > course.late_limit) reasons.push(`迟到 ${late} 次，超过允许上限 ${course.late_limit} 次`);
  if (quizzes.length === 0) reasons.push('课程尚未配置测验');
  else if (quizTaken.length < quizzes.length) reasons.push(`还有 ${quizzes.length - quizTaken.length} 个测验未完成`);
  else if (avg < course.pass_score) reasons.push(`测验平均分 ${avg}，未达及格线 ${course.pass_score}`);
  if (pending > 0) reasons.push(`还有 ${pending} 次课未签到/未结算`);

  const enrolled = !!db.prepare('SELECT 1 FROM enrollments WHERE course_id=? AND student_id=? AND status=\'active\'')
    .get(courseId, studentId);

  return {
    enrolled, allSettled,
    counts: { present, late, absent, makeup, pending, total: sessions.length },
    attendance: rows, quizzes, quizAvg: avg,
    qualified: reasons.length === 0,
    failReasons: reasons,
  };
}

function genCertNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `CERT-${ymd}-${uid(4).toUpperCase()}`;
}

// 签发证书（仅在合格时）。返回证书记录
function issueCertificate(courseId, studentId, actor, templateId) {
  const prog = getProgress(courseId, studentId);
  if (!prog.enrolled) throw new Error('学员未报名该课程');
  if (!prog.qualified) throw new Error('学员尚未达到结业条件：' + prog.failReasons.join('；'));
  const tpl = templateId
    ? db.prepare('SELECT * FROM certificate_templates WHERE id=?').get(templateId)
    : db.prepare('SELECT * FROM certificate_templates WHERE course_id=? ORDER BY id DESC LIMIT 1').get(courseId);
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
  const student = db.prepare('SELECT * FROM users WHERE id=?').get(studentId);
  const certNo = genCertNo();
  const attSummary = `共${prog.counts.total}次：正常${prog.counts.present}、迟到${prog.counts.late}、补签${prog.counts.makeup}、缺课${prog.counts.absent}`;
  const quizSummary = `${prog.quizzes.length}个测验，平均分${prog.quizAvg}`;
  const info = db.prepare(`INSERT INTO certificates
    (cert_no,course_id,student_id,template_id,issued_by,status,attendance_summary,quiz_summary,issued_at)
    VALUES (?,?,?,?,?, 'valid',?,?,?)`)
    .run(certNo, courseId, studentId, tpl ? tpl.id : null, actor.uid, attSummary, quizSummary, nowISO());
  return db.prepare('SELECT * FROM certificates WHERE id=?').get(info.lastInsertRowid);
}

// 补发：旧证置 invalid，发新证，写补发原因，可沿链追溯
function reissueCertificate(oldCertId, reason, actor) {
  const old = db.prepare('SELECT * FROM certificates WHERE id=?').get(oldCertId);
  if (!old) throw new Error('原证书不存在');
  if (old.status === 'invalid') throw new Error('该证书已失效，不能作为补发源证书');
  const prog = getProgress(old.course_id, old.student_id);
  if (!prog.qualified) throw new Error('学员当前不再满足结业条件，不能补发：' + prog.failReasons.join('；'));
  const fresh = issueCertificate(old.course_id, old.student_id, actor, old.template_id);
  db.prepare(`UPDATE certificates SET status='invalid', invalid_reason=?, superseded_by=? WHERE id=?`)
    .run(`补发：${reason}`, fresh.id, old.id);
  db.prepare(`INSERT INTO reissues(old_cert_id,new_cert_id,reason,operator_id,created_at)
    VALUES (?,?,?,?,?)`).run(old.id, fresh.id, reason, actor.uid, nowISO());
  return { old: db.prepare('SELECT * FROM certificates WHERE id=?').get(old.id), fresh };
}

module.exports = {
  db, nowISO, sha, uid, createToken, getUser, requireAuth,
  logAttendance, settleSession, getProgress, genCertNo,
  issueCertificate, reissueCertificate,
};
