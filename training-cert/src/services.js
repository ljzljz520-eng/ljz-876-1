const { db, nowISO, audit, genCode, genCertNo } = require('./db');

const STATUS_LABEL = {
  present: '正常', late: '迟到', absent: '缺课', makeup: '补签',
  pending: '待审核', approved: '已批准', rejected: '已驳回',
  valid: '有效', invalidated: '已失效', initial: '首发', reissue: '补发',
};

/* ---------- 时间窗 ---------- */
function sessionWindow(se) {
  const start = new Date(se.start_at).getTime();
  if (Number.isNaN(start)) throw new Error('课次开始时间无效');
  return {
    opensAt: new Date(start - se.open_before_min * 60000).toISOString(),
    closesAt: new Date(start + se.duration_min * 60000 + se.close_after_min * 60000).toISOString(),
    lateDeadline: new Date(start + se.late_grace_min * 60000).toISOString(),
  };
}

function sessionLiveState(se) {
  const w = sessionWindow(se);
  const t = Date.now();
  if (t < new Date(w.opensAt).getTime()) return { state: 'upcoming', ...w };
  if (t > new Date(w.closesAt).getTime()) return { state: 'closed', ...w };
  return { state: 'open', ...w };
}

/* 扫描已过签到截止时间但无考勤记录的课次，给已报名学员补 absent 记录 */
function sweepAbsences(actor = null) {
  const rows = db.prepare(`
    SELECT s.* FROM sessions s
    WHERE (?) >= (unixepoch(s.start_at) + s.duration_min*60 + s.close_after_min*60) * 1000
  `).all(Date.now());
  const ins = db.prepare(`INSERT OR IGNORE INTO attendances
    (session_id, student_id, status, note, updated_at) VALUES (?,?,?,?,?)`);
  let count = 0;
  const findEnr = db.prepare('SELECT student_id FROM enrollments WHERE course_id=?');
  for (const s of rows) {
    for (const e of findEnr.all(s.course_id)) {
      const info = ins.run(s.id, e.student_id, 'absent', '系统自动标记（签到窗口关闭未签到）', nowISO());
      if (info.changes) {
        count++;
        audit({ courseId: s.course_id, actor, action: 'auto_mark_absent', entityType: 'session', entityId: s.id,
          detail: { studentId: e.student_id } });
      }
    }
  }
  return count;
}

/* ---------- 签到 ---------- */
function checkin({ student, code }) {
  const row = db.prepare(`
    SELECT sc.*, s.id AS sid, s.course_id, s.title AS s_title, s.start_at,
           s.duration_min, s.late_grace_min, s.open_before_min, s.close_after_min
    FROM signin_codes sc JOIN sessions s ON s.id = sc.session_id
    WHERE sc.code = ? AND sc.active = 1
    ORDER BY sc.id DESC LIMIT 1`).get(String(code).trim().toUpperCase());

  if (!row) return { ok: false, status: 404, message: '签到码无效或已停用' };

  const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE course_id=? AND student_id=?')
    .get(row.course_id, student.id);
  if (!enrolled) return { ok: false, status: 403, message: '你尚未报名该课程' };

  const w = sessionWindow(row);
  const t = Date.now();
  if (t < new Date(w.opensAt).getTime())
    return { ok: false, status: 400, message: '签到尚未开放（开课前 ' + row.open_before_min + ' 分钟开放）' };
  if (t > new Date(w.closesAt).getTime())
    return { ok: false, status: 400, message: '签到窗口已关闭，可课后申请补签' };

  const existing = db.prepare('SELECT * FROM attendances WHERE session_id=? AND student_id=?')
    .get(row.sid, student.id);
  if (existing) {
    const label = STATUS_LABEL[existing.status];
    return { ok: false, status: 409, message: `已签到过（状态：${label}），无需重复签到` };
  }

  const isLate = t > new Date(w.lateDeadline).getTime();
  const status = isLate ? 'late' : 'present';
  db.prepare(`INSERT INTO attendances (session_id,student_id,status,signin_code,signed_at,note,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(row.sid, student.id, status, row.code, nowISO(),
    isLate ? '超过宽限期签到' : '', nowISO());

  audit({ courseId: row.course_id, actor: student, action: 'checkin', entityType: 'session',
    entityId: row.sid, detail: { status, code: row.code } });
  return { ok: true, status, sessionTitle: row.s_title,
    message: isLate ? '签到成功，但已超过开课后 ' + row.late_grace_min + ' 分钟宽限期，记为迟到' : '签到成功' };
}

/* ---------- 学员课程汇总 / 结业资格 ---------- */
function bestQuizScore(courseId, studentId) {
  const q = db.prepare('SELECT id FROM quizzes WHERE course_id=?').get(courseId);
  if (!q) return { quiz: null, best: null, passedQuiz: false, attempts: 0 };
  const agg = db.prepare('SELECT COUNT(*) c, MAX(score) best FROM quiz_attempts WHERE quiz_id=? AND student_id=?')
    .get(q.id, studentId);
  const course = db.prepare('SELECT pass_score FROM courses WHERE id=?').get(courseId);
  return { quiz: q, best: agg.best, attempts: agg.c, passedQuiz: agg.best != null && agg.best >= course.pass_score };
}

function attendanceSummary(courseId, studentId) {
  const total = db.prepare('SELECT COUNT(*) c FROM sessions WHERE course_id=?').get(courseId).c;
  const rows = db.prepare('SELECT status FROM attendances WHERE student_id=? AND session_id IN (SELECT id FROM sessions WHERE course_id=?)')
    .all(studentId, courseId);
  const counts = { present: 0, late: 0, absent: 0, makeup: 0 };
  for (const r of rows) counts[r.status]++;
  // 迟到按半次计入出勤（常见做法，也保证“迟到不算白来”）
  const attendedWeighted = counts.present + counts.makeup + counts.late * 0.5;
  const ratio = total ? attendedWeighted / total : 0;
  return { total, recorded: rows.length, counts, ratio,
    passedAttendance: ratio >= (db.prepare('SELECT min_attendance_ratio FROM courses WHERE id=?').get(courseId).min_attendance_ratio) };
}

function courseRoster(courseId) {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
  const students = db.prepare(`
    SELECT u.id, u.name, u.phone FROM enrollments e JOIN users u ON u.id=e.student_id
    WHERE e.course_id=? ORDER BY u.id`).all(courseId);
  const certStmt = db.prepare("SELECT * FROM certificates WHERE course_id=? AND student_id=? ORDER BY id DESC");
  return students.map((u) => {
    const att = attendanceSummary(courseId, u.id);
    const qz = bestQuizScore(courseId, u.id);
    const eligible = att.passedAttendance && qz.passedQuiz;
    const reasons = [];
    if (!att.passedAttendance) reasons.push(`出勤率 ${(att.ratio * 100).toFixed(0)}% 未达标（要求 ${(course.min_attendance_ratio * 100).toFixed(0)}%）`);
    if (!qz.passedQuiz) reasons.push(qz.best == null ? '尚未通过测验' : `测验最高 ${qz.best} 分未过线（${course.pass_score} 分）`);
    const certs = certStmt.all(courseId, u.id);
    const validCert = certs.find(c => c.status === 'valid') || null;
    return { ...u, attendance: att, quiz: { best: qz.best, attempts: qz.attempts, passed: qz.passedQuiz },
      eligible, ineligibleReason: reasons.join('；'), validCert, certCount: certs.length };
  });
}

/* ---------- 证书 ---------- */
function getTemplateOrThrow(courseId) {
  const t = db.prepare('SELECT * FROM certificate_templates WHERE course_id=?').get(courseId);
  if (!t) throw httpError(400, '请先配置证书样式');
  return t;
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function issueCertificate({ courseId, studentId, actor, reason = 'initial', supersedesId = null, extraDetail = {} }) {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
  if (!course) throw httpError(404, '课程不存在');
  const enr = db.prepare('SELECT 1 FROM enrollments WHERE course_id=? AND student_id=?').get(courseId, studentId);
  if (!enr) throw httpError(400, '学员未报名本课程');
  const template = getTemplateOrThrow(courseId);

  if (reason === 'reissue') {
    const old = db.prepare('SELECT * FROM certificates WHERE id=?').get(supersedesId);
    if (!old || old.student_id !== studentId || old.course_id !== courseId)
      throw httpError(400, '原证书不存在');
    if (old.status !== 'invalidated')
      throw httpError(400, '仅可对已失效证书进行补发');
  } else {
    const att = attendanceSummary(courseId, studentId);
    const qz = bestQuizScore(courseId, studentId);
    if (!(att.passedAttendance && qz.passedQuiz))
      throw httpError(400, '学员尚未达到结业条件（出勤率 + 测验双达标）');
    const alive = db.prepare("SELECT id FROM certificates WHERE course_id=? AND student_id=? AND status='valid'")
      .get(courseId, studentId);
    if (alive) throw httpError(409, '该学员已有有效证书，如需换发请先作废旧证');
  }

  const certNo = genCertNo();
  const info = db.prepare(`INSERT INTO certificates
    (cert_no,course_id,student_id,template_id,status,issue_reason,supersedes_id,created_at)
    VALUES (?,?,?,?,'valid',?,?,?)`)
    .run(certNo, courseId, studentId, template.id, reason, supersedesId, nowISO());
  const certId = info.lastInsertRowid;

  if (reason === 'reissue') {
    db.prepare('UPDATE certificates SET superseded_by_id=? WHERE id=?').run(certId, supersedesId);
  }
  audit({ courseId, actor, action: reason === 'reissue' ? 'cert_reissued' : 'cert_issued',
    entityType: 'certificate', entityId: certId,
    detail: { certNo, studentId, supersedesId, ...extraDetail } });
  return db.prepare('SELECT * FROM certificates WHERE id=?').get(certId);
}

function invalidateCertificate({ certId, actor, reason }) {
  const cert = db.prepare('SELECT * FROM certificates WHERE id=?').get(certId);
  if (!cert) throw httpError(404, '证书不存在');
  if (cert.status === 'invalidated') throw httpError(409, '证书已处于失效状态');
  db.prepare("UPDATE certificates SET status='invalidated', invalidate_reason=?, invalidated_at=? WHERE id=?")
    .run(reason || '主办操作作废', nowISO(), certId);
  audit({ courseId: cert.course_id, actor, action: 'cert_invalidated', entityType: 'certificate',
    entityId: certId, detail: { certNo: cert.cert_no, studentId: cert.student_id, reason } });
  return db.prepare('SELECT * FROM certificates WHERE id=?').get(certId);
}

function certChain(cert) {
  const chain = [];
  let cur = cert, guard = 0;
  // 找到链首
  while (cur.supersedes_id && guard++ < 50) {
    const prev = db.prepare('SELECT * FROM certificates WHERE id=?').get(cur.supersedes_id);
    if (!prev) break;
    cur = prev;
  }
  guard = 0;
  while (cur && guard++ < 50) {
    chain.push(cur);
    cur = cur.superseded_by_id ? db.prepare('SELECT * FROM certificates WHERE id=?').get(cur.superseded_by_id) : null;
  }
  return chain;
}

/* ---------- 课次 / 签到码管理 ---------- */
function rotateSigninCode(sessionId, actor) {
  const se = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  if (!se) throw httpError(404, '课次不存在');
  db.prepare('UPDATE signin_codes SET active=0 WHERE session_id=?').run(sessionId);
  let code;
  for (let i = 0; i < 5; i++) {
    code = genCode(6);
    const dup = db.prepare('SELECT 1 FROM signin_codes WHERE code=? AND active=1').get(code);
    if (!dup) break;
  }
  db.prepare('INSERT INTO signin_codes (session_id,code,active,created_at) VALUES (?,?,1,?)')
    .run(sessionId, code, nowISO());
  audit({ courseId: se.course_id, actor, action: 'code_rotated', entityType: 'session',
    entityId: sessionId, detail: { code } });
  return code;
}

function activeCodeForSession(sessionId) {
  return db.prepare('SELECT * FROM signin_codes WHERE session_id=? AND active=1 ORDER BY id DESC LIMIT 1')
    .get(sessionId);
}

module.exports = {
  STATUS_LABEL, sessionWindow, sessionLiveState, sweepAbsences, checkin,
  attendanceSummary, bestQuizScore, courseRoster,
  issueCertificate, invalidateCertificate, certChain,
  rotateSigninCode, activeCodeForSession, httpError,
};
