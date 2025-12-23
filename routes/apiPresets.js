const express = require('express');
const router = express.Router();

const {
  listPresets,
  createPreset,
  getPreset,
  updatePreset,
  deletePreset,
  listImpactedJobsForPreset,
} = require('../services/presetService');

router.get('/', async (req, res) => {
  const presets = await listPresets();
  res.json({ presets });
});

router.post('/', async (req, res) => {
  try {
    const preset = await createPreset(req.body || {});
    res.status(201).json(preset);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const preset = await getPreset(req.params.id);
  if (!preset) return res.status(404).json({ message: 'Preset not found' });
  res.json(preset);
});

router.put('/:id', async (req, res) => {
  try {
    const updated = await updatePreset(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ message: 'Preset not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const impacted = await listImpactedJobsForPreset(req.params.id);
  const force = req.query.force === 'true' || req.query.force === '1';
  if (impacted.length && !force) {
    return res.status(400).json({
      message: 'Preset is used by existing jobs',
      impacted_jobs: impacted.map((j) => ({ id: j.id, name: j.name })).slice(0, 50),
      total: impacted.length,
    });
  }
  const removed = await deletePreset(req.params.id);
  if (!removed) return res.status(404).json({ message: 'Preset not found' });
  res.json({ ok: true, impacted_jobs: impacted.map((j) => ({ id: j.id, name: j.name })).slice(0, 50), total: impacted.length });
});

router.get('/:id/impacted-jobs', async (req, res) => {
  const jobs = await listImpactedJobsForPreset(req.params.id);
  res.json({ impacted_jobs: jobs.map((j) => ({ id: j.id, name: j.name })).slice(0, 50), total: jobs.length });
});

module.exports = router;
