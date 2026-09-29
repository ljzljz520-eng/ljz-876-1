const crypto = require('crypto');
const { db, sha256 } = require('./db');

function createToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO auth_tokens (token,user_id,created_at) VALUES (?,?,datetime(\'now\'))')
    .run(token, userId);
  return token;
}

function getUserFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.* FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token=?`)
    .get(token);
  return row || null;
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: '请先登录' });
  req.user = user;
  req.token = token;
  next();
}

function organizerOnly(req, res, next) {
  if (req.user.role !== 'organizer') return res.status(403).json({ error: '仅主办方可用' });
  next();
}

function login(phone, password) {
  const user = db.prepare('SELECT * FROM users WHERE phone=?').get(String(phone).trim());
  if (!user || user.password_hash !== sha256(password)) return null;
  return { user, token: createToken(user.id) };
}

module.exports = { authRequired, organizerOnly, login, createToken, sha256 };
