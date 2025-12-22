const { EventsRepository } = require('../db/repositories');

async function recordEvent({ event_type, message, job_id, session_id, schedule_id, metadata }) {
  return EventsRepository.create({
    event_type,
    message,
    job_id,
    session_id,
    schedule_id,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
  });
}

module.exports = { recordEvent };
