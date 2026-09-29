// 重建演示数据：node server/seed.js
const fs = require('fs');
const dbFile = require('path').join(__dirname, '..', 'data.db');
try { ['', '-wal', '-shm'].forEach(s => fs.rmSync(dbFile + s, { force: true })); } catch {}
const db = require('./db');
const S = require('./services');
const T = () => new Date(Date.now() + T.off || 0).toISOString();
const iso = (d) => d.toISOString();
const min = 60 * 1000, hour = 60 * min, day = 24 * hour;

function mkUser(username, name, role) {
  const info = db.prepare('INSERT INTO users(username,password,name,role,created_at) VALUES (?,?,?,?,?)')
    .run(username, S.sha('123456'), name, role, iso(new Date()));
  return info.lastInsertRowid;
}

const org = mkUser('org', '王老师（主办方）', 'organizer');
const zhang = mkUser('zhang', '张三（已结业·补发证）', 'student');
const li = mkUser('li', '李四（考勤异常）', 'student');
const me = mkUser('student', '学员体验号', 'student');

const courseInfo = db.prepare(`INSERT INTO courses(organizer_id,title,description,late_grace_min,late_limit,absence_limit,pass_score,created_at)
  VALUES (?,?,?,?,?,?,?,?)`).run(org, '生产安全与质量管理培训', '三天制线下培训：考勤 + 每讲测验，全部合格方可结业。', 15, 1, 0, 60, iso(new Date()));
const cid = courseInfo.lastInsertRowid;

const tplInfo = db.prepare('INSERT INTO certificate_templates(course_id,name,title_text,body_text,created_at) VALUES (?,?,?,?,?)')
  .run(cid, '标准结业样式', '结业证书', '兹证明 {name} 已完成《{course}》全部课程学习，考勤与测验成绩合格，特发此证。', iso(new Date()));
const tplId = tplInfo.lastInsertRowid;

// 三个课次：第一节已结束（5分钟前开课，宽限10分钟，现在仍可正常签到）；第二节2小时后；第三节7天后
const base = Date.now();
const sesDefs = [
  { title: '第一讲：安全生产法规', start: new Date(base - 2 * min), end: new Date(base + 43 * min) },
  { title: '第二讲：现场风险管理', start: new Date(base + 2 * hour), end: new Date(base + 3 * hour) },
  { title: '第三讲：应急演练与考核', start: new Date(base + 7 * day), end: new Date(base + 7 * day + hour) },
];
const sessions = sesDefs.map(s => db.prepare('INSERT INTO sessions(course_id,title,start_time,end_time,created_at) VALUES (?,?,?,?,?)')
  .run(cid, s.title, iso(s.start), iso(s.end), iso(new Date())).lastInsertRowid);

// 报名
[zhang, li, me].forEach(st => db.prepare('INSERT INTO enrollments(course_id,student_id,status,enrolled_at) VALUES (?,?,\'active\',?)')
  .run(cid, st, iso(new Date())));

// 第一节签到码：开课前15分钟开放，开课45分钟后关闭（覆盖当前时间）
db.prepare('INSERT INTO codes(session_id,code,valid_from,valid_until,active,created_at) VALUES (?,?,?,?,1,?)')
  .run(sessions[0], 'SAFE01', iso(new Date(sesDefs[0].start.getTime() - 15 * min)),
       iso(new Date(sesDefs[0].start.getTime() + 45 * min)), iso(new Date()));

// 历史考勤：张三 第一讲迟到→被补签为正常(makeup)；李四 第一讲缺课(待补签演示)
function addAtt(sessionId, studentId, status, source, note, logAction, actor) {
  const info = db.prepare(`INSERT INTO attendances(session_id,student_id,status,source,checked_at,note)
    VALUES (?,?,?,?,?,?)`).run(sessionId, studentId, status, source,
    status === 'absent' ? null : iso(new Date()), note);
  db.prepare('INSERT INTO attendance_logs(attendance_id,action,actor_id,actor_name,detail,created_at) VALUES (?,?,?,?,?,?)')
    .run(info.lastInsertRowid, logAction, actor ? actor.id : null, actor ? actor.name : '系统', note, iso(new Date()));
}
// 张三：先扫码迟到，后经批准补签，保留两条日志可追溯
const zatt = db.prepare(`INSERT INTO attendances(session_id,student_id,status,source,checked_at,note)
  VALUES (?,?, 'makeup','makeup', ?, '地铁故障，已补交情况说明，主办方批准补签')`)
  .run(sessions[0], zhang, iso(new Date(sesDefs[0].start.getTime() + 25 * min))).lastInsertRowid;
db.prepare('INSERT INTO attendance_logs(attendance_id,action,actor_id,actor_name,detail,created_at) VALUES (?,?,?,?,?,?)')
  .run(zatt, 'scan', zhang, '张三（已结业·补发证）', '扫码签到：迟到（晚于开课10分钟）', iso(new Date(sesDefs[0].start.getTime() + 18 * min)));
db.prepare('INSERT INTO attendance_logs(attendance_id,action,actor_id,actor_name,detail,created_at) VALUES (?,?,?,?,?,?)')
  .run(zatt, 'makeup', org, '王老师（主办方）', '批准补签为正常出勤', iso(new Date(sesDefs[0].start.getTime() + 2 * hour)));
addAtt(sessions[0], li, 'absent', 'manual', '课次结束后系统结算缺课', 'settle', null);

// 为让张三结业（三个课次都要有考勤且测验齐全），第二、三讲用过去时间重建为历史课次
function pastSession(title, startAgo, attForZhang, attForLi) {
  const st = new Date(base - startAgo), en = new Date(st.getTime() + hour);
  const sid = db.prepare('INSERT INTO sessions(course_id,title,start_time,end_time,created_at) VALUES (?,?,?,?,?)')
    .run(cid, title, iso(st), iso(en), iso(new Date())).lastInsertRowid;
  const za = db.prepare(`INSERT INTO attendances(session_id,student_id,status,source,checked_at,note)
    VALUES (?,?,?, 'scan', ?, '')`).run(sid, zhang, attForZhang, iso(st)).lastInsertRowid;
  db.prepare('INSERT INTO attendance_logs(attendance_id,action,actor_id,actor_name,detail,created_at) VALUES (?,?,?,?,?,?)')
    .run(za, 'scan', zhang, '张三（已结业·补发证）', '扫码签到', iso(st));
  const la = db.prepare(`INSERT INTO attendances(session_id,student_id,status,source,checked_at,note)
    VALUES (?,?,?, ?, ?, ?)`).run(sid, li, attForLi.status, attForLi.source,
      attForLi.status === 'absent' ? null : iso(st), attForLi.note || '').lastInsertRowid;
  db.prepare('INSERT INTO attendance_logs(attendance_id,action,actor_id,actor_name,detail,created_at) VALUES (?,?,?,?,?,?)')
    .run(la, attForLi.log, li, '李四（考勤异常）', attForLi.detail || attForLi.note || '', iso(st));
  return sid;
}
// 删除预置的未来第二、三讲，改为 历史2讲 + 当前1讲
sessions.slice(1).forEach(sid => db.prepare('DELETE FROM sessions WHERE id=?').run(sid));
const s2 = pastSession('第二讲：现场风险管理', 3 * day, 'present',
  { status: 'late', source: 'scan', log: 'scan', detail: '扫码签到：迟到' });
const s3 = pastSession('第三讲：应急演练与考核', 6 * day, 'present',
  { status: 'absent', source: 'manual', log: 'settle', detail: '课次结束后系统结算缺课' });
const sessionIds = [sessions[0], s2, s3]; // 当前讲 + 两讲历史

// 每讲一个测验（单选），张三全部通过；李四分数有高有低但因缺课不合格
function mkQuiz(sessionId, title, qs) {
  const id = db.prepare('INSERT INTO quizzes(session_id,title,questions_json,created_at) VALUES (?,?,?,?)')
    .run(sessionId, title, JSON.stringify(qs), iso(new Date())).lastInsertRowid;
  return id;
}
const quizDefs = [
  ['第一讲测验：法规基础', [
    { q: '安全生产法规定从业人员的首要义务是？', options: ['遵守安全规章制度', '提高产量', '自行更换设备', '无需培训上岗'], answer: 0, score: 50 },
    { q: '发现事故隐患应当？', options: ['隐瞒不报', '立即报告并处置', '等下班再说', '拍照发朋友圈'], answer: 1, score: 50 },
  ]],
  ['第二讲测验：风险辨识', [
    { q: '风险评估的正确顺序是？', options: ['辨识→评估→控制', '控制→评估→辨识', '评估→辨识→控制', '辨识→控制→评估'], answer: 0, score: 60 },
    { q: '下列哪项属于个人防护用品？', options: ['安全帽', '办公椅', '工牌挂绳', '保温杯'], answer: 0, score: 40 },
  ]],
  ['第三讲测验：应急处置', [
    { q: '发生火灾首先应？', options: ['乘电梯逃离', '报警并按预案疏散', '抢救财物', '原地等待'], answer: 1, score: 60 },
    { q: '心肺复苏按压部位是？', options: ['胸骨下半段', '腹部', '头顶', '肩部'], answer: 0, score: 40 },
  ]],
];
sessionIds.forEach((sid, i) => mkQuiz(sid, quizDefs[i][0], quizDefs[i][1]));

function attempt(quizId, studentId, answers, score, at) {
  db.prepare('INSERT INTO quiz_attempts(quiz_id,student_id,score,answers_json,submitted_at) VALUES (?,?,?,?,?)')
    .run(quizId, studentId, score, JSON.stringify(answers), iso(at));
}
const quizIds = sessionIds.map(sid => db.prepare('SELECT id FROM quizzes WHERE session_id=?').get(sid).id);
// 张三：当前讲100 + 历史100/60（三讲全部合格）
attempt(quizIds[0], zhang, [0, 1], 100, new Date(base + 10 * min));
attempt(quizIds[1], zhang, [0, 0], 100, new Date(base - 3 * day));
attempt(quizIds[2], zhang, [1, 1], 60, new Date(base - 6 * day)); // 第二题错
// 李四：100 / 0（第一讲缺考无成绩，当前讲测验未作答）
attempt(quizIds[1], li, [0, 0], 100, new Date(base - 3 * day));
attempt(quizIds[2], li, [0, 1], 0, new Date(base - 6 * day));

// 张三证书链：原证书（打印错误姓名）→ 补发新证 → 新证又因污损补发（两次补发，旧证均可查原因）
function issueManual(studentId, reasonSuffix) {
  const prog = S.getProgress(cid, studentId);
  const no = S.genCertNo();
  const info = db.prepare(`INSERT INTO certificates(cert_no,course_id,student_id,template_id,issued_by,status,attendance_summary,quiz_summary,issued_at)
    VALUES (?,?,?,?,?,'valid',?,?,?)`).run(no, cid, studentId, tplId, org,
    `共3次：正常2、补签1、缺课0`, `3个测验，平均分${prog.quizAvg}`, iso(new Date(Date.now() - 5 * day)));
  return db.prepare('SELECT * FROM certificates WHERE id=?').get(info.lastInsertRowid);
}
const c1 = issueManual(zhang);
db.prepare('UPDATE certificates SET issued_at=? WHERE id=?').run(iso(new Date(base - 5 * day)), c1.id);
// 第一次补发
const c2issue = db.prepare(`INSERT INTO certificates(cert_no,course_id,student_id,template_id,issued_by,status,attendance_summary,quiz_summary,issued_at)
  VALUES (?,?,?,?,?,'valid',?,?,?)`).run(S.genCertNo(), cid, zhang, tplId, org, c1.attendance_summary, c1.quiz_summary, iso(new Date(base - 3 * day)));
const c2 = db.prepare('SELECT * FROM certificates WHERE id=?').get(c2issue.lastInsertRowid);
db.prepare(`UPDATE certificates SET status='invalid', invalid_reason=?, superseded_by=? WHERE id=?`)
  .run('补发：原证书姓名打印错误（“张叁”），申请换发', c2.id, c1.id);
db.prepare('INSERT INTO reissues(old_cert_id,new_cert_id,reason,operator_id,created_at) VALUES (?,?,?,?,?)')
  .run(c1.id, c2.id, '原证书姓名打印错误（“张叁”），申请换发', org, iso(new Date(base - 3 * day)));
// 第二次补发
const c3issue = db.prepare(`INSERT INTO certificates(cert_no,course_id,student_id,template_id,issued_by,status,attendance_summary,quiz_summary,issued_at)
  VALUES (?,?,?,?,?,'valid',?,?,?)`).run(S.genCertNo(), cid, zhang, tplId, org, c2.attendance_summary, c2.quiz_summary, iso(new Date(base - 1 * day)));
const c3 = db.prepare('SELECT * FROM certificates WHERE id=?').get(c3issue.lastInsertRowid);
db.prepare(`UPDATE certificates SET status='invalid', invalid_reason=?, superseded_by=? WHERE id=?`)
  .run('补发：学员不慎污损证书，申请补办', c3.id, c2.id);
db.prepare('INSERT INTO reissues(old_cert_id,new_cert_id,reason,operator_id,created_at) VALUES (?,?,?,?,?)')
  .run(c2.id, c3.id, '学员不慎污损证书，申请补办', org, iso(new Date(base - 1 * day)));

console.log('演示数据已就绪');
console.log('主办方: org / 123456');
console.log('已结业学员(有补发链): zhang / 123456');
console.log('考勤异常学员: li / 123456');
console.log('体验学员: student / 123456');
console.log('当前开讲课次签到码: SAFE01（第一讲正在签到窗口）');
console.log('张三的有效证书号:', c3.cert_no, '（也可用旧证号', c1.cert_no, '查到补发链）');
