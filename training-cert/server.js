const path = require('path');
const express = require('express');
const { init } = require('./src/db');
const svc = require('./src/services');

init();

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/organizer', require('./src/routes/organizer'));
app.use('/api/student', require('./src/routes/student'));
app.use('/api', require('./src/routes/public'));

app.use(express.static(path.join(__dirname, 'public')));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || '服务器错误' });
});

// 每分钟扫描一次已关闭签到窗口、自动标记缺课
setInterval(() => { try { svc.sweepAbsences(null); } catch (e) { /* ignore */ } }, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`培训签到证书平台已启动: http://localhost:${PORT}`);
});
