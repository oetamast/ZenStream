const express = require('express');
const router = express.Router();
const {
  createSchedule,
  updateSchedule,
  disableSchedule,
  deleteSchedule,
} = require('../services/jobService');
const { SchedulesRepository } = require('../db/repositories');

router.post('/', async (req, res) => {
  try {
    const result = await createSchedule(req.body || {});
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const result = await updateSchedule(req.params.id, req.body || {});
    if (!result) return res.status(404).json({ message: 'Schedule not found' });
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post('/:id/disable', async (req, res) => {
  try {
    const schedule = await disableSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ message: 'Schedule not found' });
    res.json({ schedule });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const schedule = await deleteSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ message: 'Schedule not found' });
    res.json({ schedule });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const schedule = await SchedulesRepository.findById(req.params.id);
  if (!schedule) return res.status(404).json({ message: 'Schedule not found' });
  res.json({ schedule });
});

router.all('*', (req, res) => {
  res.status(404).json({ message: 'Not found' });
});

module.exports = router;
