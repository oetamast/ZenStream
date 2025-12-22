const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('./database');

const AssetsRepository = {
  async create(asset) {
    const id = asset.id || uuidv4();
    await run(
      `INSERT INTO assets (id, type, filename, path, size_bytes, status, metadata_json, thumbnail_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        asset.type,
        asset.filename,
        asset.path,
        asset.size_bytes || 0,
        asset.status || 'ready',
        asset.metadata_json || null,
        asset.thumbnail_path || null,
      ]
    );
    return { ...asset, id };
  },
  findById(id) {
    return get('SELECT * FROM assets WHERE id = ?', [id]);
  },
  async update(id, updates) {
    const existing = await this.findById(id);
    if (!existing) return null;
    const merged = {
      ...existing,
      ...updates,
    };
    await run(
      `UPDATE assets
       SET type = ?, filename = ?, path = ?, size_bytes = ?, status = ?, metadata_json = ?, thumbnail_path = ?
       WHERE id = ?`,
      [
        merged.type,
        merged.filename,
        merged.path,
        merged.size_bytes || 0,
        merged.status,
        merged.metadata_json || null,
        merged.thumbnail_path || null,
        id,
      ]
    );
    return this.findById(id);
  },
  list() {
    return all('SELECT * FROM assets ORDER BY created_at DESC');
  },
  listFiltered(filter = {}) {
    const where = [];
    const params = [];
    if (filter.type) {
      where.push('type = ?');
      params.push(filter.type);
    }
    if (filter.query) {
      where.push('LOWER(filename) LIKE ?');
      params.push(`%${filter.query.toLowerCase()}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return all(`SELECT * FROM assets ${clause} ORDER BY datetime(created_at) DESC`, params);
  },
};

const DestinationsRepository = {
  async create(destination) {
    const id = destination.id || uuidv4();
    await run(
      `INSERT INTO destinations (id, name, platform, stream_url, stream_key_enc, created_at, updated_at, is_valid)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, 1))`,
      [
        id,
        destination.name,
        destination.platform || 'youtube',
        destination.stream_url,
        destination.stream_key_enc || '',
        destination.created_at,
        destination.updated_at,
        destination.is_valid === undefined ? 1 : destination.is_valid ? 1 : 0,
      ]
    );
    return { ...destination, id };
  },
  findById(id) {
    return get('SELECT * FROM destinations WHERE id = ?', [id]);
  },
  list() {
    return all('SELECT * FROM destinations ORDER BY datetime(created_at) DESC');
  },
  async update(id, updates) {
    await run(
      `UPDATE destinations
       SET name = COALESCE(?, name),
           platform = COALESCE(?, platform),
           stream_url = COALESCE(?, stream_url),
           stream_key_enc = COALESCE(?, stream_key_enc),
           is_valid = COALESCE(?, is_valid),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        updates.name,
        updates.platform,
        updates.stream_url,
        updates.stream_key_enc,
        updates.is_valid !== undefined ? (updates.is_valid ? 1 : 0) : null,
        id,
      ]
    );
    return this.findById(id);
  },
  async remove(id) {
    return run('DELETE FROM destinations WHERE id = ?', [id]);
  },
};

function mapPreset(row) {
  if (!row) return null;
  return {
    ...row,
    remux_enabled: !!row.remux_enabled,
    force_encode: !!row.force_encode,
  };
}

const PresetsRepository = {
  async create(preset) {
    const id = preset.id || uuidv4();
    await run(
      `INSERT INTO presets (id, name, video_codec, audio_codec, remux_enabled, force_encode)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        preset.name,
        preset.video_codec || null,
        preset.audio_codec || null,
        preset.remux_enabled ? 1 : 0,
        preset.force_encode ? 1 : 0,
      ]
    );
    return this.findById(id);
  },
  list() {
    return all('SELECT * FROM presets ORDER BY created_at DESC').then((rows) => rows.map(mapPreset));
  },
  async findById(id) {
    const row = await get('SELECT * FROM presets WHERE id = ?', [id]);
    return mapPreset(row);
  },
  async update(id, updates) {
    const existing = await this.findById(id);
    if (!existing) return null;
    const merged = {
      name: updates.name ?? existing.name,
      video_codec: updates.video_codec === undefined ? existing.video_codec : updates.video_codec,
      audio_codec: updates.audio_codec === undefined ? existing.audio_codec : updates.audio_codec,
      remux_enabled: updates.remux_enabled === undefined ? existing.remux_enabled : updates.remux_enabled,
      force_encode: updates.force_encode === undefined ? existing.force_encode : updates.force_encode,
    };
    await run(
      `UPDATE presets
       SET name = ?, video_codec = ?, audio_codec = ?, remux_enabled = ?, force_encode = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        merged.name,
        merged.video_codec || null,
        merged.audio_codec || null,
        merged.remux_enabled ? 1 : 0,
        merged.force_encode ? 1 : 0,
        id,
      ]
    );
    return this.findById(id);
  },
  remove(id) {
    return run('DELETE FROM presets WHERE id = ?', [id]);
  },
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
  async update(id, updates) {
    const job = await this.findById(id);
    if (!job) return null;
    const merged = {
      name: updates.name ?? job.name,
      video_asset_id: updates.video_asset_id ?? job.video_asset_id,
      destination_id: updates.destination_id ?? job.destination_id,
      preset_id: updates.preset_id === undefined ? job.preset_id : updates.preset_id,
      loop_enabled: updates.loop_enabled === undefined ? job.loop_enabled : updates.loop_enabled ? 1 : 0,
      crossfade_seconds: updates.crossfade_seconds === undefined ? job.crossfade_seconds : updates.crossfade_seconds,
      invalid_reason: updates.invalid_reason === undefined ? job.invalid_reason : updates.invalid_reason
    };
    await run(
      `UPDATE jobs
       SET name = ?, video_asset_id = ?, destination_id = ?, preset_id = ?, loop_enabled = ?, crossfade_seconds = ?, invalid_reason = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        merged.name,
        merged.video_asset_id,
        merged.destination_id,
        merged.preset_id || null,
        merged.loop_enabled,
        merged.crossfade_seconds || null,
        merged.invalid_reason || null,
        id
      ]
    );
    return this.findById(id);
  },
  updateStatus(id, status, invalidReason = null) {
    return run(
      'UPDATE jobs SET status = ?, invalid_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, invalidReason, id]
    );
  },
  findById(id) {
    return get('SELECT * FROM jobs WHERE id = ?', [id]);
  },
  list() {
    return all('SELECT * FROM jobs ORDER BY created_at DESC');
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
  },
  findById(id) {
    return get('SELECT * FROM schedules WHERE id = ?', [id]);
  },
  async update(id, updates) {
    const schedule = await this.findById(id);
    if (!schedule) return null;
    const merged = {
      start_at: updates.start_at ?? schedule.start_at,
      end_at: updates.end_at === undefined ? schedule.end_at : updates.end_at,
      timezone: updates.timezone ?? schedule.timezone,
      enabled: updates.enabled === undefined ? schedule.enabled : updates.enabled,
    };
    await run(
      `UPDATE schedules
       SET start_at = ?, end_at = ?, timezone = ?, enabled = ?, created_at = created_at
       WHERE id = ?`,
      [merged.start_at, merged.end_at || null, merged.timezone, merged.enabled ? 1 : 0, id]
    );
    return this.findById(id);
  },
  async disable(id) {
    await run('UPDATE schedules SET enabled = 0 WHERE id = ?', [id]);
    return this.findById(id);
  },
  async delete(id) {
    return run('DELETE FROM schedules WHERE id = ?', [id]);
  },
  findNextEnabled(jobId, nowUtcIso) {
    return get(
      `SELECT * FROM schedules
       WHERE job_id = ? AND enabled = 1 AND datetime(start_at) > datetime(?)
       ORDER BY datetime(start_at) ASC LIMIT 1`,
      [jobId, nowUtcIso]
    );
  },
  listDue(nowUtcIso) {
    return all(
      `SELECT s.* FROM schedules s
       LEFT JOIN sessions sess ON s.id = sess.schedule_id AND sess.status IN ('pending','running')
       WHERE s.enabled = 1 AND datetime(s.start_at) <= datetime(?) AND sess.id IS NULL
       ORDER BY datetime(s.start_at) ASC`,
      [nowUtcIso]
    );
  }
};

const SessionsRepository = {
  async create(session) {
    const id = session.id || uuidv4();
    await run(
      `INSERT INTO sessions (id, job_id, schedule_id, status, started_at, ended_at, target_end_at, error, restart_count, snapshot_stream_key_enc, log_path, stop_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        session.job_id,
        session.schedule_id || null,
        session.status || 'pending',
        session.started_at || null,
        session.ended_at || null,
        session.target_end_at || null,
        session.error || null,
        session.restart_count || 0,
        session.snapshot_stream_key_enc || null,
        session.log_path || null,
        session.stop_reason || null
      ]
    );
    return { ...session, id };
  },
  updateStatus(id, status, error = null, stop_reason = null) {
    return run(
      'UPDATE sessions SET status = ?, error = ?, stop_reason = ?, ended_at = CASE WHEN ? IN ("stopped", "failed") THEN CURRENT_TIMESTAMP ELSE ended_at END WHERE id = ?',
      [status, error, stop_reason, status, id]
    );
  },
  async incrementRestartCount(id) {
    await run('UPDATE sessions SET restart_count = restart_count + 1 WHERE id = ?', [id]);
    return this.findById(id);
  },
  async markRunning(id, startedAt, logPath) {
    await run(
      'UPDATE sessions SET status = "running", started_at = ?, log_path = ?, error = NULL WHERE id = ?',
      [startedAt, logPath || null, id]
    );
    return this.findById(id);
  },
  findRunningByJob(jobId) {
    return get(
      'SELECT * FROM sessions WHERE job_id = ? AND status = "running" ORDER BY datetime(started_at) DESC LIMIT 1',
      [jobId]
    );
  },
  findPending() {
    return all('SELECT * FROM sessions WHERE status = "pending" ORDER BY created_at ASC');
  },
  findRunning() {
    return all('SELECT * FROM sessions WHERE status = "running"');
  },
  findById(id) {
    return get('SELECT * FROM sessions WHERE id = ?', [id]);
  },
  hasHistory(jobId) {
    return get('SELECT COUNT(1) as count FROM sessions WHERE job_id = ?', [jobId]).then((row) => row?.count > 0);
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
      `INSERT OR IGNORE INTO settings (id, timezone, language, retention_days, keep_forever, safety_cap_enabled, benchmark_profile)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      [
        settings.timezone,
        settings.language,
        settings.retention_days,
        settings.keep_forever ? 1 : 0,
        settings.safety_cap_enabled ? 1 : 0,
        settings.benchmark_profile || 'safe',
      ]
    );
    await run(
      `UPDATE settings SET timezone = ?, language = ?, retention_days = ?, keep_forever = ?, safety_cap_enabled = ?, benchmark_profile = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
      [
        settings.timezone,
        settings.language,
        settings.retention_days,
        settings.keep_forever ? 1 : 0,
        settings.safety_cap_enabled ? 1 : 0,
        settings.benchmark_profile || 'safe',
      ]
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
