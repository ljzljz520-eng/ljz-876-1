const express = require('express');
const QRCode = require('qrcode');
const { db } = require('../db');

const router = express.Router();

/* 公开查验：按证书编号查询，失效证书同样可查（含补发链与作废原因） */
router.get('/verify/:certNo', async (req, res) => {
  const certNo = String(req.params.certNo).trim().toUpperCase();
  const cert = db.prepare(`
    SELECT ce.*, c.title AS course_title, c.description AS course_description,
      u.name AS student_name, u.phone AS student_phone,
      t.org_name, t.title AS tpl_title, t.subtitle, t.signer_name, t.signer_title, t.accent_color
    FROM certificates ce
    JOIN courses c ON c.id=ce.course_id
    JOIN users u ON u.id=ce.student_id
    JOIN certificate_templates t ON t.id=ce.template_id
    WHERE ce.cert_no=?`).get(certNo);
  if (!cert) return res.status(404).json({ error: '未找到该编号对应的证书，请核对编号' });

  const chain = require('../services').certChain(cert).map((x) => {
    const stu = db.prepare('SELECT name FROM users WHERE id=?').get(x.student_id);
    const events = db.prepare(`SELECT action, actor_label, detail_json, created_at
      FROM audit_events WHERE entity_type='certificate' AND entity_id=CAST(? AS TEXT)
      ORDER BY id`).all(x.id);
    return {
      id: x.id, certNo: x.cert_no, status: x.status, issueReason: x.issue_reason,
      createdAt: x.created_at, invalidatedAt: x.invalidated_at,
      invalidateReason: x.invalidate_reason, studentName: stu.name, events,
    };
  });

  const verifyUrl = `${req.protocol}://${req.get('host')}/#/verify/${encodeURIComponent(cert.cert_no)}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 200, margin: 1 });
  res.json({
    found: true,
    certificate: {
      certNo: cert.cert_no, status: cert.status, issueReason: cert.issue_reason,
      createdAt: cert.created_at, invalidatedAt: cert.invalidated_at,
      invalidateReason: cert.invalidate_reason,
      courseTitle: cert.course_title, studentName: cert.student_name,
      orgName: cert.org_name, tplTitle: cert.tpl_title, subtitle: cert.subtitle,
      signerName: cert.signer_name, signerTitle: cert.signer_title, accentColor: cert.accent_color,
    },
    chain, verifyUrl, qrDataUrl,
  });
});

module.exports = router;
