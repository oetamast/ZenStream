const { DestinationsRepository } = require('../db/repositories');
const { recordEvent } = require('./eventService');
const { encryptSecret, decryptSecret } = require('../utils/crypto');

function buildRtmpTarget(stream_url, stream_key) {
  const trimmedUrl = (stream_url || '').trim().replace(/\/$/, '');
  const key = (stream_key || '').trim().replace(/^\//, '');
  if (!key) return trimmedUrl;
  if (trimmedUrl.endsWith(`/${key}`) || trimmedUrl.includes(key)) {
    return trimmedUrl;
  }
  return `${trimmedUrl}/${key}`;
}

function validateDestinationInput({ name, platform, stream_url, stream_key }) {
  if (!name || !name.trim()) return 'Name is required';
  const platformVal = platform || 'youtube';
  if (platformVal !== 'youtube') return 'Only youtube platform is supported in v1';
  if (!stream_url || !/^rtmps?:\/\//i.test(stream_url)) {
    return 'stream_url must start with rtmp:// or rtmps://';
  }
  if (stream_key && /\s/.test(stream_key)) {
    return 'stream_key cannot contain whitespace';
  }
  return null;
}

function serialize(destination) {
  if (!destination) return null;
  return {
    id: destination.id,
    name: destination.name,
    platform: destination.platform,
    stream_url: destination.stream_url,
    created_at: destination.created_at,
    updated_at: destination.updated_at,
    has_stream_key: !!(destination.stream_key_enc && destination.stream_key_enc.length > 0),
  };
}

async function createDestination(payload) {
  const error = validateDestinationInput(payload);
  if (error) throw new Error(error);

  const record = await DestinationsRepository.create({
    name: payload.name.trim(),
    platform: payload.platform || 'youtube',
    stream_url: payload.stream_url.trim(),
    stream_key_enc: encryptSecret(payload.stream_key ? payload.stream_key.trim() : ''),
    is_valid: 1,
  });

  await recordEvent({
    event_type: 'destination_created',
    message: `Destination ${record.name} created`,
    metadata: { platform: record.platform },
  });

  return serialize(record);
}

async function updateDestination(id, payload) {
  const existing = await DestinationsRepository.findById(id);
  if (!existing) return null;
  const error = validateDestinationInput({ ...existing, ...payload });
  if (error) throw new Error(error);

  const updates = {
    name: payload.name?.trim() ?? existing.name,
    platform: payload.platform || existing.platform,
    stream_url: payload.stream_url?.trim() ?? existing.stream_url,
    stream_key_enc:
      payload.stream_key !== undefined
        ? encryptSecret(payload.stream_key ? payload.stream_key.trim() : '')
        : existing.stream_key_enc,
    is_valid: 1,
  };

  const updated = await DestinationsRepository.update(id, updates);
  await recordEvent({
    event_type: 'destination_updated',
    message: `Destination ${updated.name} updated`,
    metadata: { platform: updated.platform },
  });
  return serialize(updated);
}

async function deleteDestination(id) {
  const existing = await DestinationsRepository.findById(id);
  if (!existing) return false;
  await DestinationsRepository.remove(id);
  await recordEvent({
    event_type: 'destination_deleted',
    message: `Destination ${existing.name} deleted`,
    metadata: { platform: existing.platform },
  });
  return true;
}

async function revealStreamKey(id) {
  const dest = await DestinationsRepository.findById(id);
  if (!dest) return null;
  return decryptSecret(dest.stream_key_enc);
}

async function listDestinations() {
  const list = await DestinationsRepository.list();
  return list.map(serialize);
}

async function getDestination(id) {
  const dest = await DestinationsRepository.findById(id);
  return serialize(dest);
}

module.exports = {
  createDestination,
  updateDestination,
  deleteDestination,
  revealStreamKey,
  listDestinations,
  getDestination,
  buildRtmpTarget,
  validateDestinationInput,
};
