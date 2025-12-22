const express = require('express');
const router = express.Router();
const { stopAllSessions, stopSession } = require('../services/jobService');
const { SessionsRepository } = require('../db/repositories');

router.get('/', async (req, res) => {
  const sessions = await SessionsRepository.findRunning();
  res.json({ sessions });
});

router.post('/stop-all', async (_req, res) => {
  try {
    const stopped = await stopAllSessions();
    res.json({ stopped });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  try {
    const session = await SessionsRepository.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    const stopped = await stopSession(session.job_id, 'user_stop');
    if (!stopped) return res.status(404).json({ message: 'Session not running' });
    res.json({ session: stopped });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.all('*', (req, res) => {
  res.status(404).json({ message: 'Not found' });
});

module.exports = router;
