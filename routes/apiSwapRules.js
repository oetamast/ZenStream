const express = require('express');
const router = express.Router();
const { readSettings, isTierAtLeast } = require('../services/settingsService');

async function gateUltimate(res) {
  const settings = await readSettings();
  if (!isTierAtLeast(settings.license_tier, 'ultimate')) {
    res.status(403).json({ error: 'requires_ultimate', message: 'Ultimate tier is required for swap rules' });
    return null;
  }
  return settings;
}

router.get('/', async (_req, res) => {
  const allowed = await gateUltimate(res);
  if (!allowed) return;
  res.status(501).json({ error: 'not_implemented', message: 'Swap rules are coming soon' });
});

router.post('/', async (_req, res) => {
  const allowed = await gateUltimate(res);
  if (!allowed) return;
  res.status(501).json({ error: 'not_implemented', message: 'Swap rules are coming soon' });
});

router.put('/:id', async (_req, res) => {
  const allowed = await gateUltimate(res);
  if (!allowed) return;
  res.status(501).json({ error: 'not_implemented', message: 'Swap rules are coming soon' });
});

router.delete('/:id', async (_req, res) => {
  const allowed = await gateUltimate(res);
  if (!allowed) return;
  res.status(501).json({ error: 'not_implemented', message: 'Swap rules are coming soon' });
});

module.exports = router;
