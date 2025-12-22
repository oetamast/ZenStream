const express = require('express');
const router = express.Router();
const { readSettings, writeSettings } = require('../services/settingsService');

router.get('/', async (_req, res) => {
  try {
    const settings = await readSettings();
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to load settings' });
  }
});

router.put('/', async (req, res) => {
  try {
    const allowed = ['timezone', 'language', 'retention_days', 'keep_forever', 'safety_cap_enabled', 'benchmark_profile'];
    const payload = {};
    allowed.forEach((key) => {
      if (typeof req.body[key] !== 'undefined') payload[key] = req.body[key];
    });
    if (payload.keep_forever != null) payload.keep_forever = payload.keep_forever ? 1 : 0;
    if (payload.safety_cap_enabled != null) payload.safety_cap_enabled = payload.safety_cap_enabled ? 1 : 0;

    if (!payload.keep_forever) {
      const days = Number(payload.retention_days);
      if (!Number.isFinite(days)) {
        return res.status(400).json({ message: 'Retention days must be a number' });
      }
      if (days < 1 || days > 3650) {
        return res.status(400).json({ message: 'Retention days must be between 1 and 3650' });
      }
      payload.retention_days = Math.round(days);
    }
    const settings = await writeSettings(payload);
    res.json({ settings });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update settings' });
  }
});

router.all('*', (_req, res) => {
  res.status(404).json({ message: 'Not found' });
});

module.exports = router;
