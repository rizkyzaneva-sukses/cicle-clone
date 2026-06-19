const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const activeTab = ['umum', 'report'].includes(String(req.query.tab || '').toLowerCase())
    ? String(req.query.tab).toLowerCase()
    : 'umum';
  res.render('panduan', { activeTab });
});

module.exports = router;
