const express = require('express');
const { db, nowISO, sha256 } = require('../db');
const { login, authRequired } = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { phone, password } = req.body || {};
  const result = login(phone, password);
  if (!result) return res.status(401).json({ error: '手机号或密码错误' });
  const { user, token } = result;
  res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, role: user.role } });
});

router.post('/register-student', (req, res) => {
  const { name, phone, password } = req.body || {};
  if (!name || !phone || !password) return res.status(400).json({ error: '姓名、手机号、密码均必填' });
  const exists = db.prepare('SELECT 1 FROM users WHERE phone=?').get(String(phone).trim());
  if (exists) return res.status(409).json({ error: '该手机号已注册' });
  const info = db.prepare('INSERT INTO users (name,phone,password_hash,role,created_at) VALUES (?,?,?,\'student\',?)')
    .run(name.trim(), String(phone).trim(), sha256(password), nowISO());
  const result = login(phone, password);
  res.status(201).json({ token: result.token, user: { id: info.lastInsertRowid, name: name.trim(), phone: String(phone).trim(), role: 'student' } });
});

router.post('/logout', authRequired, (req, res) => {
  db.prepare('DELETE FROM auth_tokens WHERE token=?').run(req.token);
  res.json({ ok: true });
});

router.get('/me', authRequired, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, phone: u.phone, role: u.role });
});

module.exports = router;
