const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('organizer','student')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizer_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  late_grace_min INTEGER NOT NULL DEFAULT 10,   -- 开课后多少分钟内签到算正常
  late_limit INTEGER NOT NULL DEFAULT 3,        -- 允许迟到次数上限
  absence_limit INTEGER NOT NULL DEFAULT 0,     -- 允许缺课次数上限
  pass_score INTEGER NOT NULL DEFAULT 60,       -- 测验平均分及格线
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  start_time TEXT NOT NULL,   -- ISO，本地时间
  end_time TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','dropped')),
  enrolled_at TEXT NOT NULL,
  UNIQUE(course_id, student_id)
);

-- attendance.status: present 正常 / late 迟到 / absent 缺课 / makeup 补签
CREATE TABLE IF NOT EXISTS attendances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('present','late','absent','makeup')),
  source TEXT NOT NULL DEFAULT 'scan' CHECK(source IN ('scan','manual','makeup')),
  checked_at TEXT,
  note TEXT DEFAULT '',
  UNIQUE(session_id, student_id)
);

CREATE TABLE IF NOT EXISTS attendance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attendance_id INTEGER NOT NULL REFERENCES attendances(id) ON DELETE CASCADE,
  action TEXT NOT NULL,           -- scan / settle / makeup / revoke_makeup
  actor_id INTEGER REFERENCES users(id),
  actor_name TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  questions_json TEXT NOT NULL,   -- [{q, options:[], answer:idx, score}]
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  score INTEGER NOT NULL,
  answers_json TEXT NOT NULL,
  submitted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS certificate_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title_text TEXT NOT NULL DEFAULT '结业证书',
  body_text TEXT NOT NULL DEFAULT '兹证明 {name} 已完成《{course}》全部课程，考勤与测验合格，特发此证。',
  created_at TEXT NOT NULL
);

-- certificates.status: valid 有效 / invalid 已失效（被补发取代）/ revoked 吊销
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_no TEXT UNIQUE NOT NULL,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  template_id INTEGER REFERENCES certificate_templates(id),
  issued_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','invalid','revoked')),
  invalid_reason TEXT DEFAULT '',
  superseded_by INTEGER REFERENCES certificates(id),
  attendance_summary TEXT DEFAULT '',
  quiz_summary TEXT DEFAULT '',
  issued_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reissues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  old_cert_id INTEGER NOT NULL REFERENCES certificates(id),
  new_cert_id INTEGER NOT NULL REFERENCES certificates(id),
  reason TEXT NOT NULL,
  operator_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_course ON sessions(course_id);
CREATE INDEX IF NOT EXISTS idx_att_student ON attendances(student_id);
CREATE INDEX IF NOT EXISTS idx_cert_student ON certificates(student_id);
`);

module.exports = db;
