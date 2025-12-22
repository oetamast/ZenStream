const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { EventsRepository, SessionsRepository } = require('../db/repositories');
const { paths } = require('../utils/storage');

const listEvents = async (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const events = await EventsRepository.listRecent(limit);
  res.json({ events });
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
