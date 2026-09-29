const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.TRAINING_DB || path.join(__dirname, '..', 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function nowISO() {
  return new Date().toISOString();
}

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('organizer','student')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    organizer_id INTEGER NOT NULL REFERENCES users(id),
    min_attendance_ratio REAL NOT NULL DEFAULT 0.8,
    pass_score INTEGER NOT NULL DEFAULT 60,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 90,
    late_grace_min INTEGER NOT NULL DEFAULT 10,
    open_before_min INTEGER NOT NULL DEFAULT 30,
    close_after_min INTEGER NOT NULL DEFAULT 60,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signin_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enrolled_at TEXT NOT NULL,
    UNIQUE (course_id, student_id)
  );

  CREATE TABLE IF NOT EXISTS attendances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('present','late','absent','makeup')),
    signin_code TEXT,
    signed_at TEXT,
    note TEXT DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, student_id)
  );

  CREATE TABLE IF NOT EXISTS makeup_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id INTEGER NOT NULL REFERENCES attendances(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    reviewed_by INTEGER REFERENCES users(id),
    review_note TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    options_json TEXT NOT NULL,
    correct_index INTEGER NOT NULL,
    score INTEGER NOT NULL DEFAULT 20
  );

  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score INTEGER NOT NULL,
    answers_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS certificate_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
    org_name TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT DEFAULT '',
    signer_name TEXT NOT NULL,
    signer_title TEXT DEFAULT '',
    accent_color TEXT NOT NULL DEFAULT '#1d4ed8',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cert_no TEXT NOT NULL UNIQUE,
    course_id INTEGER NOT NULL REFERENCES courses(id),
    student_id INTEGER NOT NULL REFERENCES users(id),
    template_id INTEGER NOT NULL REFERENCES certificate_templates(id),
    status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','invalidated')),
    issue_reason TEXT NOT NULL DEFAULT 'initial' CHECK (issue_reason IN ('initial','reissue')),
    supersedes_id INTEGER REFERENCES certificates(id),
    superseded_by_id INTEGER REFERENCES certificates(id),
    invalidate_reason TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    invalidated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER REFERENCES courses(id),
    actor_id INTEGER REFERENCES users(id),
    actor_label TEXT DEFAULT '',
    action TEXT NOT NULL,
    entity_type TEXT DEFAULT '',
    entity_id TEXT DEFAULT '',
    detail_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_course ON sessions(course_id);
  CREATE INDEX IF NOT EXISTS idx_att_session ON attendances(session_id);
  CREATE INDEX IF NOT EXISTS idx_att_student ON attendances(student_id);
  CREATE INDEX IF NOT EXISTS idx_cert_student ON certificates(student_id);
  CREATE INDEX IF NOT EXISTS idx_cert_course ON certificates(course_id);
  CREATE INDEX IF NOT EXISTS idx_audit_course ON audit_events(course_id);
  CREATE INDEX IF NOT EXISTS idx_makeup_status ON makeup_requests(status);
  `);
}

function audit({ courseId = null, actor = null, action, entityType = '', entityId = '', detail = {} }) {
  db.prepare(`INSERT INTO audit_events
    (course_id, actor_id, actor_label, action, entity_type, entity_id, detail_json, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    courseId ?? null,
    actor?.id ?? null,
    actor ? `${actor.name}(${actor.role})` : '系统',
    action, entityType, entityId == null ? '' : String(entityId),
    JSON.stringify(detail ?? {}), nowISO()
  );
}

function genCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function genCertNo() {
  const d = new Date();
  const y = d.getFullYear();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `CERT-${y}-${rand}`;
}

module.exports = { db, init, sha256, nowISO, audit, genCode, genCertNo };
