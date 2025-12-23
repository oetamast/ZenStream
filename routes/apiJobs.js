const express = require('express');
const router = express.Router();
const {
  buildJobPayload,
  createJob,
  updateJob,
  runJobNow,
  stopSession,
  refreshJobStatus,
} = require('../services/jobService');
const { JobsRepository, AssetsRepository, DestinationsRepository } = require('../db/repositories');

router.get('/', async (req, res) => {
  try {
    const filter = req.query.filter === 'fix_required' ? { fix_required: true } : {};
    const jobs = await JobsRepository.list(filter);
    await Promise.all(jobs.map((job) => refreshJobStatus(job.id)));
    const refreshedJobs = await JobsRepository.list(filter);
    const hydrated = await Promise.all(refreshedJobs.map(buildJobPayload));
    res.json({ jobs: hydrated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      name,
      video_asset_id,
      destination_id,
      preset_id,
      loop_enabled,
      crossfade_seconds,
      auto_recovery_enabled,
      audio_replace_config,
      hot_swap_mode,
      scenes_json,
      swap_rules_json,
    } = req.body;
    if (!name || !video_asset_id || !destination_id) {
      return res.status(400).json({ message: 'name, video_asset_id, and destination_id are required' });
    }
    const asset = await AssetsRepository.findById(video_asset_id);
    if (!asset) return res.status(400).json({ message: 'Invalid asset' });
    const destination = await DestinationsRepository.findById(destination_id);
    if (!destination) return res.status(400).json({ message: 'Invalid destination' });

    const job = await createJob({
      name,
      video_asset_id,
      destination_id,
      preset_id,
      loop_enabled: Boolean(loop_enabled),
      crossfade_seconds: crossfade_seconds ? Number(crossfade_seconds) : null,
      auto_recovery_enabled,
      audio_replace_config,
      hot_swap_mode,
      scenes_json,
      swap_rules_json,
    });
    const payload = await buildJobPayload(job);
    res.status(201).json({ job: payload });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message, error: err.code });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const job = await updateJob(req.params.id, req.body);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const payload = await buildJobPayload(job);
    res.json({ job: payload });
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ message: err.message, error: err.code });
  }
});

router.post('/:id/run-now', async (req, res) => {
  try {
    const session = await runJobNow(req.params.id, req.body || {});
    res.status(201).json({ session });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  try {
    const stopped = await stopSession(req.params.id, 'user_stop');
    if (!stopped) return res.status(404).json({ message: 'No running session for job' });
    await refreshJobStatus(req.params.id);
    res.json({ session: stopped });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.all('*', (req, res) => {
  res.status(404).json({ message: 'Not found' });
});

module.exports = router;
