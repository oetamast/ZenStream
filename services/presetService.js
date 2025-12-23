const { PresetsRepository, JobsRepository } = require('../db/repositories');
const { recordEvent } = require('./eventService');
const { invalidateJobs } = require('./jobService');

const CODEC_PATTERN = /^[A-Za-z0-9_\.\-]+$/;

function validateCodec(value) {
  if (!value) return null;
  return CODEC_PATTERN.test(value) ? null : 'Codec strings must be alphanumeric with optional - _ . characters';
}

function normalizeFlags(payload) {
  const force_encode = !!payload.force_encode;
  const remux_enabled = force_encode ? false : payload.remux_enabled !== undefined ? !!payload.remux_enabled : true;
  if (remux_enabled && force_encode) {
    return { error: 'remux_enabled and force_encode cannot both be true' };
  }
  return { remux_enabled, force_encode };
}

function validatePresetInput(payload) {
  if (!payload.name || !payload.name.trim()) return 'Name is required';
  const { error } = normalizeFlags(payload);
  if (error) return error;
  const videoCodecError = validateCodec(payload.video_codec);
  if (videoCodecError) return videoCodecError;
  const audioCodecError = validateCodec(payload.audio_codec);
  if (audioCodecError) return audioCodecError;
  return null;
}

async function createPreset(payload) {
  const error = validatePresetInput(payload);
  if (error) throw new Error(error);
  const flags = normalizeFlags(payload);
  const record = await PresetsRepository.create({
    name: payload.name.trim(),
    video_codec: payload.video_codec || null,
    audio_codec: payload.audio_codec || null,
    remux_enabled: flags.remux_enabled,
    force_encode: flags.force_encode,
  });
  await recordEvent({
    event_type: 'preset_created',
    message: `Preset ${record.name} created`,
    metadata: { force_encode: record.force_encode, remux_enabled: record.remux_enabled },
  });
  return record;
}

async function updatePreset(id, payload) {
  const existing = await PresetsRepository.findById(id);
  if (!existing) return null;
  const merged = { ...existing, ...payload };
  const error = validatePresetInput(merged);
  if (error) throw new Error(error);
  const flags = normalizeFlags(merged);
  const updated = await PresetsRepository.update(id, {
    name: merged.name.trim(),
    video_codec: merged.video_codec || null,
    audio_codec: merged.audio_codec || null,
    remux_enabled: flags.remux_enabled,
    force_encode: flags.force_encode,
  });
  await recordEvent({
    event_type: 'preset_updated',
    message: `Preset ${updated.name} updated`,
    metadata: { force_encode: updated.force_encode, remux_enabled: updated.remux_enabled },
  });
  return updated;
}

async function deletePreset(id) {
  const existing = await PresetsRepository.findById(id);
  if (!existing) return false;
  const impactedJobs = await JobsRepository.findByPreset(id);
  await PresetsRepository.remove(id);
  if (impactedJobs?.length) {
    const reason = `Preset removed: ${existing.name}. Please choose another preset.`;
    await invalidateJobs(
      impactedJobs.map((j) => j.id),
      reason
    );
  }
  await recordEvent({
    event_type: 'preset_deleted',
    message: `Preset ${existing.name} deleted${impactedJobs?.length ? ` (impacted ${impactedJobs.length} jobs)` : ''}`,
  });
  return true;
}

async function listImpactedJobsForPreset(id) {
  const jobs = await JobsRepository.findByPreset(id);
  return jobs || [];
}

async function listPresets() {
  return PresetsRepository.list();
}

async function getPreset(id) {
  return PresetsRepository.findById(id);
}

module.exports = {
  createPreset,
  updatePreset,
  deletePreset,
  listPresets,
  getPreset,
  validatePresetInput,
  normalizeFlags,
  listImpactedJobsForPreset,
};
