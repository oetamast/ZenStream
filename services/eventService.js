const { EventsRepository, JobsRepository, DestinationsRepository } = require('../db/repositories');
const { notifyEvent } = require('./telegramService');

function mapEventKey(event_type, metadata = {}) {
  switch (event_type) {
    case 'ffmpeg_started':
      return 'stream_start';
    case 'session_stopped':
      if (metadata.reason === 'user_stop' || metadata.reason === 'stop_all') return 'stream_stop';
      return null;
    case 'session_failed':
      return 'stream_fail';
    case 'retry_gave_up':
      return 'retry_gave_up';
    case 'license_fail':
      return 'license_fail';
    case 'license_grace_started':
      return 'license_grace_started';
    case 'license_grace_ended':
      return 'license_grace_ended';
    default:
      return null;
  }
}

async function recordEvent({ event_type, message, job_id, session_id, schedule_id, metadata, notify = true }) {
  const event = await EventsRepository.create({
    event_type,
    message,
    job_id,
    session_id,
    schedule_id,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
  });

  if (!notify) return event;
  const eventKey = mapEventKey(event_type, metadata || {});
  if (!eventKey) return event;

  try {
    let job = null;
    if (job_id) {
      job = await JobsRepository.findById(job_id);
    }
    let destination = null;
    if (job?.destination_id) {
      destination = await DestinationsRepository.findById(job.destination_id);
    }
    await notifyEvent(eventKey, {
      event,
      job,
      destination,
      metadata: metadata || {},
    });
  } catch (err) {
    console.error('Failed to send telegram notification:', err.message);
  }

  return event;
}

module.exports = { recordEvent, mapEventKey };
