const express = require('express');
const {
  createDestination,
  updateDestination,
  deleteDestination,
  revealStreamKey,
  listDestinations,
  getDestination,
} = require('../services/destinationService');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const data = await listDestinations();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const dest = await createDestination(req.body || {});
    res.status(201).json(dest);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const dest = await getDestination(req.params.id);
    if (!dest) return res.status(404).json({ message: 'Destination not found' });
    res.json(dest);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const dest = await updateDestination(req.params.id, req.body || {});
    if (!dest) return res.status(404).json({ message: 'Destination not found' });
    res.json(dest);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await deleteDestination(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Destination not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/:id/reveal', async (req, res) => {
  try {
    const key = await revealStreamKey(req.params.id);
    if (key === null) return res.status(404).json({ message: 'Destination not found' });
    res.json({ stream_key: key });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
