/* 初始化演示数据：重置数据库并写入一个已结业课程（覆盖全部状态）+ 一个进行中的课程 */
const fs = require('fs');
const path = require('path');
for (const f of ['data.sqlite', 'data.sqlite-wal', 'data.sqlite-shm']) {
  const p = path.join(__dirname, f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
const { db, init, sha256, nowISO, audit } = require('./src/db');
const svc = require('./src/services');
init();

const at = (d) => new Date(d).toISOString();
const insUser = db.prepare('INSERT INTO users (name,phone,password_hash,role,created_at) VALUES (?,?,?,?,?)');
function user(name, phone, role) {
  const info = insUser.run(name, phone, sha256('123456'), role, at('2026-08-25T08:00:00+08:00'));
  return info.lastInsertRowid;
}

const org = user('王老师', '13000000001', 'organizer');
const sZhang = user('张伟', '13800000001', 'student');
const sLi = user('李娜', '13800000002', 'student');
const sWang = user('王强', '13800000003', 'student');
const sZhao = user('赵敏', '13800000004', 'student');
const sSun = user('孙杰', '13800000005', 'student');
const organizer = db.prepare('SELECT * FROM users WHERE id=?').get(org);

/* ========== 课程 1：已完成的安全生产培训 ========== */
const c1 = db.prepare(`INSERT INTO courses
  (title,description,organizer_id,min_attendance_ratio,pass_score,status,created_at)
  VALUES (?,?,?,?,?,?,?)`).run(
  '生产安全与应急管理培训',
  '面向一线作业人员的安全生产法规、消防与应急救护专题培训，共 4 次课。',
  org, 0.8, 60, 'active', at('2026-09-01T09:00:00+08:00')).lastInsertRowid;

const insSession = db.prepare(`INSERT INTO sessions
  (course_id,title,start_at,duration_min,late_grace_min,open_before_min,close_after_min,created_at)
  VALUES (?,?,?,?,?,?,?,?)`);
const sessionDates = [
  ['第1讲 安全生产法规与岗位责任', '2026-09-08T09:00:00+08:00'],
  ['第2讲 消防安全与器材实操', '2026-09-10T09:00:00+08:00'],
  ['第3讲 触电与机械伤害防护', '2026-09-15T09:00:00+08:00'],
  ['第4讲 应急救护与结业考核', '2026-09-17T14:00:00+08:00'],
];
const sessions = sessionDates.map(([title, d]) => insSession.run(
  c1, title, at(d), 90, 10, 30, 60, at('2026-09-01T10:00:00+08:00')).lastInsertRowid);

const insCode = db.prepare('INSERT INTO signin_codes (session_id,code,active,created_at) VALUES (?,?,1,?)');
sessions.forEach((sid, i) => insCode.run(sid, ['SAF008', 'FIR010', 'POW015', 'AID017'][i],
  at(sessionDates[i][1])));

const insEnr = db.prepare('INSERT INTO enrollments (course_id,student_id,enrolled_at) VALUES (?,?,?)');
[sZhang, sLi, sWang, sZhao, sSun].forEach((sid) => insEnr.run(c1, sid, at('2026-09-02T10:00:00+08:00')));

/* 考勤矩阵 */
const insAtt = db.prepare(`INSERT INTO attendances
  (session_id,student_id,status,signin_code,signed_at,note,updated_at) VALUES (?,?,?,?,?,?,?)`);
function mark(sid, studentId, status, day, signedOffsetMin, note = '') {
  const base = new Date(sessionDates[sid - sessions[0]][1]).getTime();
  const signed = status === 'absent' ? null : new Date(base + signedOffsetMin * 60000).toISOString();
  insAtt.run(sid, studentId, status,
    status === 'absent' ? null : ['SAF008', 'FIR010', 'POW015', 'AID017'][sessions.indexOf(sid)],
    signed, note, signed || at('2026-09-17T18:00:00+08:00'));
}
// 张伟：全勤
mark(sessions[0], sZhang, 'present', 0, -2);
mark(sessions[1], sZhang, 'present', 1, -5);
mark(sessions[2], sZhang, 'present', 2, -3);
mark(sessions[3], sZhang, 'present', 3, 1);
// 李娜：第2讲迟到，其余正常
mark(sessions[0], sLi, 'present', 0, -4);
mark(sessions[1], sLi, 'late', 1, 18, '超过 10 分钟宽限期，记迟到');
mark(sessions[2], sLi, 'present', 2, -6);
mark(sessions[3], sLi, 'present', 3, -2);
// 王强：第2、3讲缺课（补签一驳一审）
mark(sessions[0], sWang, 'present', 0, 3);
insAtt.run(sessions[1], sWang, 'absent', null, null, '系统自动标记（签到窗口关闭未签到）', at('2026-09-10T12:00:00+08:00'));
insAtt.run(sessions[2], sWang, 'absent', null, null, '系统自动标记（签到窗口关闭未签到）', at('2026-09-15T12:00:00+08:00'));
mark(sessions[3], sWang, 'present', 3, 2);
// 赵敏：全勤（但测验未通过；其旧证后因代签被撤销）
mark(sessions[0], sZhao, 'present', 0, -8);
mark(sessions[1], sZhao, 'present', 1, -7);
mark(sessions[2], sZhao, 'present', 2, -9);
mark(sessions[3], sZhao, 'present', 3, -4);
// 孙杰：第2讲补签通过
mark(sessions[0], sSun, 'present', 0, 4);
insAtt.run(sessions[1], sSun, 'makeup', null, null, '补签批准：当日家中突发急事迟到后离场，已提交情况说明（情况属实）', at('2026-09-12T15:00:00+08:00'));
mark(sessions[2], sSun, 'present', 2, -1);
mark(sessions[3], sSun, 'present', 3, 3);

/* 补签申请 */
const attWangS2 = db.prepare('SELECT id FROM attendances WHERE session_id=? AND student_id=?').get(sessions[1], sWang).id;
const attWangS3 = db.prepare('SELECT id FROM attendances WHERE session_id=? AND student_id=?').get(sessions[2], sWang).id;
const attSunS2 = db.prepare('SELECT id FROM attendances WHERE session_id=? AND student_id=?').get(sessions[1], sSun).id;
db.prepare(`INSERT INTO makeup_requests (attendance_id,student_id,reason,status,reviewed_by,review_note,created_at,reviewed_at)
  VALUES (?,?,?, 'rejected', ?, ?, ?, ?)`).run(attWangS2, sWang, '当天堵车没赶上，忘记提前请假',
  org, '未在课后 24 小时内提交，且无有效证明材料，不予补签。',
  at('2026-09-11T09:00:00+08:00'), at('2026-09-11T16:00:00+08:00'));
db.prepare(`INSERT INTO makeup_requests (attendance_id,student_id,reason,status,created_at)
  VALUES (?,?,?, 'pending', ?)`).run(attWangS3, sWang, '当日突发高烧 39 度赴急诊，可补充病历与挂号记录，申请补签。',
  at('2026-09-16T08:30:00+08:00'));
db.prepare(`INSERT INTO makeup_requests (attendance_id,student_id,reason,status,reviewed_by,review_note,created_at,reviewed_at)
  VALUES (?,?,?, 'approved', ?, ?, ?, ?)`).run(attSunS2, sSun,
  '家中老人突发身体不适送医，课后才赶回，申请补签。', org, '情况属实，已核验就医记录，准予补签。',
  at('2026-09-11T20:00:00+08:00'), at('2026-09-12T15:00:00+08:00'));

/* 测验 + 题目 */
const quiz = db.prepare('INSERT INTO quizzes (course_id,title,created_at) VALUES (?,?,?)')
  .run(c1, '安全生产知识结业测验', at('2026-09-16T10:00:00+08:00')).lastInsertRowid;
const questions = [
  ['发现初起火灾时，正确的第一步处置是？', ['乘坐电梯迅速离开', '组织疏散并拨打 119 报警', '返回工位抢救财物', '关闭门窗等待救援'], 1],
  ['电器设备起火应优先使用哪种灭火器？', ['干粉灭火器', '清水灭火器', '泡沫灭火器', '不需要灭火'], 0],
  ['成人心肺复苏的胸外按压部位是？', ['胸骨中下 1/3 处', '左上臂', '腹部正中', '头顶'], 0],
  ['进入作业现场佩戴安全帽的主要作用是？', ['防止物体打击等头部伤害', '防晒', '防雨', '统一着装美观'], 0],
  ['发现他人触电，首先应当做什么？', ['直接用手拉开伤者', '迅速切断电源', '向伤者泼水', '用力摇晃伤者'], 1],
];
const insQ = db.prepare('INSERT INTO questions (quiz_id,seq,text,options_json,correct_index,score) VALUES (?,?,?,?,?,20)');
questions.forEach(([text, opts, ci], i) => insQ.run(quiz, i + 1, text, JSON.stringify(opts), ci));

/* 测验作答：按正确数造分 */
const insAttempt = db.prepare('INSERT INTO quiz_attempts (quiz_id,student_id,score,answers_json,created_at) VALUES (?,?,?,?,?)');
function attempt(studentId, correctCount, d) {
  const details = questions.map((q, i) => ({ questionId: i + 1, given: i < correctCount ? q[2] : (q[2] + 1) % q[1].length,
    correct: q[2], ok: i < correctCount }));
  insAttempt.run(quiz, studentId, correctCount * 20, JSON.stringify({ details }), at(d));
}
attempt(sZhang, 4, '2026-09-17T15:30:00+08:00'); // 80
attempt(sLi, 3, '2026-09-17T15:35:00+08:00');     // 60 及格线 60
attempt(sWang, 2, '2026-09-17T15:40:00+08:00');    // 40
attempt(sZhao, 2, '2026-09-17T15:45:00+08:00');    // 40 不及格
attempt(sSun, 4, '2026-09-17T15:50:00+08:00');     // 80（先记一次 65 更真实，改为直接 80?）

/* 证书样式 */
const tpl = db.prepare(`INSERT INTO certificate_templates
  (course_id,org_name,title,subtitle,signer_name,signer_title,accent_color,updated_at)
  VALUES (?,?,?,?,?,?,?,?)`).run(c1, '华晟职业培训中心', '结业证书',
  'CERTIFICATE OF COMPLETION', '刘建华', '培训中心主任', '#1d4ed8',
  at('2026-09-01T11:00:00+08:00')).lastInsertRowid;

/* 证书：张伟首发有效 */
const cZhang = db.prepare(`INSERT INTO certificates
  (cert_no,course_id,student_id,template_id,status,issue_reason,created_at)
  VALUES (?,?,?,?,'valid','initial',?)`).run('CERT-2026-A0001', c1, sZhang, tpl, at('2026-09-18T10:00:00+08:00')).lastInsertRowid;
/* 李娜：首发 -> 姓名错别字作废 -> 补发有效 */
const cLiOld = db.prepare(`INSERT INTO certificates
  (cert_no,course_id,student_id,template_id,status,issue_reason,created_at)
  VALUES (?,?,?,?,'valid','initial',?)`).run('CERT-2026-A0002', c1, sLi, tpl, at('2026-09-18T10:05:00+08:00')).lastInsertRowid;
db.prepare(`UPDATE certificates SET status='invalidated', invalidate_reason=?, invalidated_at=? WHERE id=?`)
  .run('学员反馈证书姓名与身份证不一致（系统录入错别字），原证作废后补发新证。', at('2026-09-20T09:00:00+08:00'), cLiOld);
const cLiNew = db.prepare(`INSERT INTO certificates
  (cert_no,course_id,student_id,template_id,status,issue_reason,supersedes_id,created_at)
  VALUES (?,?,?,?,'valid','reissue',?,?)`).run('CERT-2026-A0005', c1, sLi, tpl, cLiOld, at('2026-09-20T09:10:00+08:00')).lastInsertRowid;
db.prepare('UPDATE certificates SET superseded_by_id=? WHERE id=?').run(cLiNew, cLiOld);
/* 孙杰：补签结业后首发有效 */
db.prepare(`INSERT INTO certificates
  (cert_no,course_id,student_id,template_id,status,issue_reason,created_at)
  VALUES (?,?,?,?,'valid','initial',?)`).run('CERT-2026-A0003', c1, sSun, tpl, at('2026-09-19T14:00:00+08:00'));
/* 赵敏：曾误发证书，后因代签被撤销（无补发） */
const cZhao = db.prepare(`INSERT INTO certificates
  (cert_no,course_id,student_id,template_id,status,issue_reason,created_at)
  VALUES (?,?,?,?,'valid','initial',?)`).run('CERT-2026-A0004', c1, sZhao, tpl, at('2026-09-18T10:10:00+08:00')).lastInsertRowid;
db.prepare(`UPDATE certificates SET status='invalidated', invalidate_reason=?, invalidated_at=? WHERE id=?`)
  .run('课后复核监控发现第 2 次课由他人代为签到，违反诚信规定，撤销结业证书；且该学员结业测验未达标，不予补发。',
  at('2026-09-22T16:00:00+08:00'), cZhao);

/* 审计事件（与种子数据一致） */
audit({ courseId: c1, actor: organizer, action: 'course_created', entityType: 'course', entityId: c1, detail: { title: '生产安全与应急管理培训' } });
sessions.forEach((sid, i) => audit({ courseId: c1, actor: organizer, action: 'session_created', entityType: 'session', entityId: sid, detail: { title: sessionDates[i][0] } }));
audit({ courseId: c1, actor: organizer, action: 'quiz_saved', entityType: 'quiz', entityId: quiz, detail: { count: 5 } });
audit({ courseId: c1, actor: organizer, action: 'template_saved', entityType: 'certificate_template', entityId: tpl });
audit({ courseId: c1, actor: organizer, action: 'cert_issued', entityType: 'certificate', entityId: cZhang, detail: { certNo: 'CERT-2026-A0001', studentId: sZhang } });
audit({ courseId: c1, actor: organizer, action: 'cert_issued', entityType: 'certificate', entityId: cLiOld, detail: { certNo: 'CERT-2026-A0002', studentId: sLi } });
audit({ courseId: c1, actor: organizer, action: 'cert_invalidated', entityType: 'certificate', entityId: cLiOld, detail: { certNo: 'CERT-2026-A0002', reason: '姓名错别字，作废重发' } });
audit({ courseId: c1, actor: organizer, action: 'cert_reissued', entityType: 'certificate', entityId: cLiNew, detail: { certNo: 'CERT-2026-A0005', supersedesId: cLiOld, reason: '更正姓名后补发' } });
audit({ courseId: c1, actor: organizer, action: 'cert_invalidated', entityType: 'certificate', entityId: cZhao, detail: { certNo: 'CERT-2026-A0004', reason: '代签作弊，撤销证书' } });

/* ========== 课程 2：进行中的课程（供现场扫码演示） ========== */
const c2 = db.prepare(`INSERT INTO courses
  (title,description,organizer_id,min_attendance_ratio,pass_score,status,created_at)
  VALUES (?,?,?,?,?,?,?)`).run(
  '新员工入职培训（第 3 期）', '进行中的课程：现场生成签到码、学员扫码签到、配置测验与证书样式。',
  org, 0.8, 60, 'active', nowISO()).lastInsertRowid;
// 开始时间设在 10 分钟后，提前 60 分钟开放签到 => 现在即可签到
const start2 = new Date(Date.now() + 10 * 60000).toISOString();
const sess2 = insSession.run(c2, '开班第一课：企业文化与规章制度', start2, 90, 10, 60, 120, nowISO()).lastInsertRowid;
const code2 = svc.rotateSigninCode(sess2, organizer);
[sZhang, sLi, sWang].forEach((sid) => insEnr.run(c2, sid, nowISO()));
audit({ courseId: c2, actor: organizer, action: 'course_created', entityType: 'course', entityId: c2, detail: { title: '新员工入职培训（第 3 期）' } });
audit({ courseId: c2, actor: organizer, action: 'session_created', entityType: 'session', entityId: sess2, detail: { code: code2 } });

console.log('种子数据完成');
console.log('主办方: 13000000001 / 123456');
console.log('学员: 13800000001~005 / 123456 (张伟 李娜 王强 赵敏 孙杰)');
console.log('进行中课程当前签到码:', code2);
console.log('可查验证书编号: CERT-2026-A0001(有效) / A0002(已失效,补发A0005) / A0004(已撤销)');
