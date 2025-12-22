const express = require('express');
const router = express.Router();

const {
  listPresets,
  createPreset,
  getPreset,
  updatePreset,
  deletePreset,
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
  const removed = await deletePreset(req.params.id);
  if (!removed) return res.status(404).json({ message: 'Preset not found' });
  res.json({ ok: true });
});

module.exports = router;
