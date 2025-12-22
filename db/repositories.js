const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('./database');

const AssetsRepository = {
  async create(asset) {
    const id = asset.id || uuidv4();
    await run(
      `INSERT INTO assets (id, type, filename, path, size_bytes, status, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, asset.type, asset.filename, asset.path, asset.size_bytes || 0, asset.status || 'ready', asset.metadata_json || null]
    );
    return { ...asset, id };
  },
  findById(id) {
    return get('SELECT * FROM assets WHERE id = ?', [id]);
  },
  list() {
    return all('SELECT * FROM assets ORDER BY created_at DESC');
  }
};

const DestinationsRepository = {
  async create(destination) {
    const id = destination.id || uuidv4();
    await run(
      `INSERT INTO destinations (id, name, platform, stream_url, stream_key_enc)
       VALUES (?, ?, ?, ?, ?)`,
      [id, destination.name, destination.platform || 'youtube', destination.stream_url, destination.stream_key_enc]
    );
    return { ...destination, id };
  },
  list() {
    return all('SELECT * FROM destinations ORDER BY created_at DESC');
  }
};

const PresetsRepository = {
  async create(preset) {
    const id = preset.id || uuidv4();
    await run(
      `INSERT INTO presets (id, name, remux_enabled, force_encode)
       VALUES (?, ?, ?, ?)`,
      [id, preset.name, preset.remux_enabled ? 1 : 0, preset.force_encode ? 1 : 0]
    );
    return { ...preset, id };
  },
  list() {
    return all('SELECT * FROM presets ORDER BY created_at DESC');
  }
};

const JobsRepository = {
  async create(job) {
    const id = job.id || uuidv4();
    await run(
      `INSERT INTO jobs (id, name, video_asset_id, destination_id, preset_id, loop_enabled, crossfade_seconds, status, invalid_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        job.name,
        job.video_asset_id,
        job.destination_id,
        job.preset_id || null,
        job.loop_enabled ? 1 : 0,
        job.crossfade_seconds || null,
        job.status || 'idle',
        job.invalid_reason || null
      ]
    );
    return { ...job, id };
  },
  updateStatus(id, status, invalidReason = null) {
    return run(
      'UPDATE jobs SET status = ?, invalid_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, invalidReason, id]
    );
  },
  findById(id) {
    return get('SELECT * FROM jobs WHERE id = ?', [id]);
  }
};

const SchedulesRepository = {
  async create(schedule) {
    const id = schedule.id || uuidv4();
    await run(
      `INSERT INTO schedules (id, job_id, start_at, end_at, timezone, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        schedule.job_id,
        schedule.start_at,
        schedule.end_at || null,
        schedule.timezone,
        schedule.enabled === false ? 0 : 1
      ]
    );
    return { ...schedule, id };
  },
  listByJob(jobId) {
    return all('SELECT * FROM schedules WHERE job_id = ? ORDER BY start_at DESC', [jobId]);
  }
};

const SessionsRepository = {
  async create(session) {
    const id = session.id || uuidv4();
    await run(
      `INSERT INTO sessions (id, job_id, schedule_id, status, started_at, ended_at, error, restart_count, snapshot_stream_key_enc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        session.job_id,
        session.schedule_id || null,
        session.status || 'pending',
        session.started_at || null,
        session.ended_at || null,
        session.error || null,
        session.restart_count || 0,
        session.snapshot_stream_key_enc || null
      ]
    );
    return { ...session, id };
  },
  updateStatus(id, status, error = null) {
    return run(
      'UPDATE sessions SET status = ?, error = ?, ended_at = CASE WHEN ? IN ("stopped", "failed") THEN CURRENT_TIMESTAMP ELSE ended_at END WHERE id = ?',
      [status, error, status, id]
    );
  }
};

const EventsRepository = {
  async create(event) {
    const id = event.id || uuidv4();
    await run(
      `INSERT INTO events (id, event_type, message, job_id, session_id, schedule_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        event.event_type,
        event.message,
        event.job_id || null,
        event.session_id || null,
        event.schedule_id || null,
        event.metadata_json || null
      ]
    );
    return { ...event, id };
  },
  listRecent(limit = 50) {
    return all('SELECT * FROM events ORDER BY created_at DESC LIMIT ?', [limit]);
  }
};

const LogPartsRepository = {
  async append(logPart) {
    const id = logPart.id || uuidv4();
    await run(
      `INSERT INTO log_parts (id, session_id, part_number, content)
       VALUES (?, ?, ?, ?)`,
      [id, logPart.session_id, logPart.part_number, logPart.content || null]
    );
    return { ...logPart, id };
  },
  listBySession(sessionId) {
    return all('SELECT * FROM log_parts WHERE session_id = ? ORDER BY part_number ASC', [sessionId]);
  }
};

const SettingsRepository = {
  async read() {
    return get('SELECT * FROM settings WHERE id = 1');
  },
  async write(settings) {
    await run(
      `INSERT OR IGNORE INTO settings (id, timezone, language, retention_days, keep_forever)
       VALUES (1, ?, ?, ?, ?)`,
      [settings.timezone, settings.language, settings.retention_days, settings.keep_forever ? 1 : 0]
    );
    await run(
      `UPDATE settings SET timezone = ?, language = ?, retention_days = ?, keep_forever = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
      [settings.timezone, settings.language, settings.retention_days, settings.keep_forever ? 1 : 0]
    );
    return this.read();
  }
};

module.exports = {
  AssetsRepository,
  DestinationsRepository,
  PresetsRepository,
  JobsRepository,
  SchedulesRepository,
  SessionsRepository,
  EventsRepository,
  LogPartsRepository,
  SettingsRepository,
};
