const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { EventsRepository, SessionsRepository } = require('../db/repositories');
const { paths } = require('../utils/storage');
const { readSettings } = require('../services/settingsService');
const { normalizeRetentionSettings } = require('../services/retentionService');
const { DateTime } = require('luxon');

const listEvents = async (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const [events, settings] = await Promise.all([
    EventsRepository.listRecent(limit),
    readSettings()
  ]);
  const policy = normalizeRetentionSettings(settings);
  const now = DateTime.utc();
  const mapped = events.map((ev) => {
    const created = DateTime.fromISO(ev.created_at, { zone: 'utc' }).isValid
      ? DateTime.fromISO(ev.created_at, { zone: 'utc' })
      : DateTime.fromSQL(ev.created_at, { zone: 'utc' });
    let expires_at = null;
    let delete_in_days = null;
    if (!policy.keepForever && created.isValid) {
      const expires = created.plus({ days: policy.retentionDays });
      expires_at = expires.toISO();
      delete_in_days = Math.max(0, Math.ceil(expires.diff(now, 'days').days));
    }
    return { ...ev, expires_at, delete_in_days };
  });
  res.json({
    events: mapped,
    keep_forever: policy.keepForever,
    retention_days: policy.retentionDays,
  });
};

router.get('/', listEvents);
router.get('/events', listEvents);

router.get('/sessions/:id/log', async (req, res) => {
  const session = await SessionsRepository.findById(req.params.id);
  if (!session) return res.status(404).json({ message: 'Session not found' });

  const logPath = session.log_path || path.join(paths.logs, 'ffmpeg', `session_${session.id}.log`);
  if (!fs.existsSync(logPath)) {
    return res.status(404).json({ message: 'Log not found' });
  }

  const lines = Number(req.query.lines) || 200;
  const content = fs.readFileSync(logPath, 'utf8');
  const trimmed = content.split(/\r?\n/).slice(lines * -1).join('\n');
  res.type('text/plain').send(trimmed);
});

router.all('*', (req, res) => {
  res.status(404).json({ message: 'Not found' });
});

module.exports = router;
