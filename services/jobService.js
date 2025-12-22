const { DateTime } = require('luxon');
const {
  AssetsRepository,
  DestinationsRepository,
  JobsRepository,
  SchedulesRepository,
  SessionsRepository,
} = require('../db/repositories');
const { readSettings } = require('./settingsService');
const { recordEvent } = require('./eventService');
const { refreshJobStatus } = require('./jobStatusService');

function normalizeZone(zone, fallback = 'UTC') {
  if (!zone) return fallback;
  try {
    const dt = DateTime.now().setZone(zone);
    if (dt.isValid) return zone;
    return fallback;
  } catch (err) {
    return fallback;
  }
}

function parseAssetDurationSeconds(asset) {
  if (!asset || !asset.metadata_json) return null;
  try {
    const parsed = JSON.parse(asset.metadata_json);
    if (parsed.duration_sec) return Number(parsed.duration_sec);
    if (parsed.duration) return Number(parsed.duration);
    if (parsed.format && parsed.format.duration) return Number(parsed.format.duration);
    return null;
  } catch (err) {
    return null;
  }
}

function validateDurationAgainstAsset(durationSeconds, assetDuration, loopEnabled) {
  if (!durationSeconds || !assetDuration) return null;
  if (!loopEnabled && durationSeconds > assetDuration) {
    return 'Schedule exceeds asset duration and loop is disabled';
  }
  return null;
}

function computeDurationSeconds(startDt, endDt) {
  if (!startDt || !endDt) return null;
  const diff = endDt.diff(startDt, 'seconds').seconds;
  return diff > 0 ? diff : null;
}

async function buildJobPayload(job) {
  if (!job) return null;
  const nowUtcIso = DateTime.utc().toISO();
  const [next_schedule, current_session] = await Promise.all([
    SchedulesRepository.findNextEnabled(job.id, nowUtcIso),
    SessionsRepository.findRunningByJob(job.id),
  ]);
  return { ...job, next_schedule, current_session };
}

async function createJob(payload) {
  const asset = await AssetsRepository.findById(payload.video_asset_id);
  if (!asset) throw new Error('Asset not found');
  const destination = await DestinationsRepository.findById(payload.destination_id);
  if (!destination) throw new Error('Destination not found');

  const job = await JobsRepository.create({
    name: payload.name,
    video_asset_id: payload.video_asset_id,
    destination_id: payload.destination_id,
    preset_id: payload.preset_id || null,
    loop_enabled: payload.loop_enabled ? 1 : 0,
    crossfade_seconds: payload.loop_enabled ? payload.crossfade_seconds || null : null,
    status: 'idle',
  });
  await refreshJobStatus(job.id);
  return job;
}

async function updateJob(id, payload) {
  const existing = await JobsRepository.findById(id);
  if (!existing) return null;
  const updates = {
    name: payload.name,
    destination_id: payload.destination_id,
    preset_id: payload.preset_id,
    loop_enabled: payload.loop_enabled,
    crossfade_seconds: payload.loop_enabled ? payload.crossfade_seconds : null,
    invalid_reason: payload.invalid_reason,
  };
  if (payload.video_asset_id) {
    const asset = await AssetsRepository.findById(payload.video_asset_id);
    if (!asset) throw new Error('Asset not found');
    updates.video_asset_id = payload.video_asset_id;
  }
  const updated = await JobsRepository.update(id, updates);
  await refreshJobStatus(id);
  return updated;
}

async function stopSession(jobId, reason = 'stopped') {
  const running = await SessionsRepository.findRunningByJob(jobId);
  if (!running) return null;
  const { stopSessionProcess } = require('./runnerService');
  await stopSessionProcess(running, reason);
  await refreshJobStatus(jobId);
  return running;
}

async function evaluateOpenEnded(loopEnabled, targetEnd) {
  if (!targetEnd && !loopEnabled) {
    return 'Open-ended sessions require loop to be enabled';
  }
  return null;
}

async function runJobNow(jobId, options = {}) {
  const job = await JobsRepository.findById(jobId);
  if (!job) throw new Error('Job not found');
  const asset = await AssetsRepository.findById(job.video_asset_id);
  if (!asset) throw new Error('Asset not found for job');
  const settings = await readSettings();
  const zone = normalizeZone(options.timezone || settings.timezone);
  const startTime = options.start_at_override
    ? DateTime.fromISO(options.start_at_override, { zone: 'utc' }).setZone(zone)
    : DateTime.now().setZone(zone);
  if (!startTime.isValid) throw new Error('Invalid start time');

  let targetEnd = null;
  if (options.end_at) {
    targetEnd = DateTime.fromISO(options.end_at, { zone });
    if (!targetEnd.isValid) throw new Error('Invalid end_at');
  } else if (options.duration_minutes) {
    targetEnd = startTime.plus({ minutes: Number(options.duration_minutes) });
  }

  if (targetEnd && targetEnd <= startTime) {
    throw new Error('End time must be in the future');
  }

  const openEndedError = await evaluateOpenEnded(job.loop_enabled, targetEnd);
  if (openEndedError) {
    await JobsRepository.updateStatus(job.id, 'invalid', openEndedError);
    await recordEvent({ event_type: 'session_blocked', message: openEndedError, job_id: job.id });
    throw new Error(openEndedError);
  }

  const assetDuration = parseAssetDurationSeconds(asset);
  const durationSeconds = targetEnd ? targetEnd.diff(startTime, 'seconds').seconds : null;
  const durationError = validateDurationAgainstAsset(durationSeconds, assetDuration, job.loop_enabled);
  if (durationError) {
    await JobsRepository.updateStatus(job.id, 'invalid', durationError);
    await recordEvent({ event_type: 'session_blocked', message: durationError, job_id: job.id });
    throw new Error(durationError);
  }

  const session = await SessionsRepository.create({
    job_id: job.id,
    status: 'pending',
    started_at: startTime.toUTC().toISO(),
    target_end_at: targetEnd ? targetEnd.toUTC().toISO() : null,
  });
  await JobsRepository.updateStatus(job.id, 'running', null);
  await recordEvent({
    event_type: 'session_created',
    message: 'Session created via run now',
    job_id: job.id,
    session_id: session.id,
    metadata: { mode: 'run_now', duration_minutes: options.duration_minutes || null, end_at: targetEnd ? targetEnd.toISO() : null },
  });
  return session;
}

async function createSchedule(payload) {
  const job = await JobsRepository.findById(payload.job_id);
  if (!job) throw new Error('Job not found');
  const asset = await AssetsRepository.findById(job.video_asset_id);
  if (!asset) throw new Error('Asset not found for job');
  const settings = await readSettings();
  const zone = normalizeZone(payload.timezone || settings.timezone);
  const start = DateTime.fromISO(payload.start_at, { zone });
  if (!start.isValid) throw new Error('Invalid start_at');
  const now = DateTime.now().setZone(zone);
  if (start <= now) throw new Error('Start must be in the future');
  const end = payload.end_at ? DateTime.fromISO(payload.end_at, { zone }) : null;
  if (end && !end.isValid) throw new Error('Invalid end_at');
  if (end && end <= start) throw new Error('End must be after start');

  const openEndedError = await evaluateOpenEnded(job.loop_enabled, end);
  if (openEndedError) {
    await JobsRepository.updateStatus(job.id, 'invalid', openEndedError);
    await recordEvent({ event_type: 'session_blocked', message: openEndedError, job_id: job.id });
    throw new Error(openEndedError);
  }

  const assetDuration = parseAssetDurationSeconds(asset);
  const durationSeconds = computeDurationSeconds(start, end);
  const durationError = validateDurationAgainstAsset(durationSeconds, assetDuration, job.loop_enabled);
  const schedule = await SchedulesRepository.create({
    job_id: job.id,
    start_at: start.toUTC().toISO(),
    end_at: end ? end.toUTC().toISO() : null,
    timezone: zone,
    enabled: payload.enabled !== false,
  });
  await recordEvent({
    event_type: 'schedule_created',
    message: 'Schedule created',
    job_id: job.id,
    schedule_id: schedule.id,
    metadata: { start_at: schedule.start_at, end_at: schedule.end_at, timezone: zone },
  });

  if (durationError) {
    await JobsRepository.updateStatus(job.id, 'invalid', durationError);
    await recordEvent({ event_type: 'session_blocked', message: durationError, job_id: job.id, schedule_id: schedule.id });
  } else {
    await JobsRepository.updateStatus(job.id, payload.enabled === false ? job.status : 'planned', null);
    await refreshJobStatus(job.id);
  }
  return { schedule, warning: durationError };
}

async function updateSchedule(id, payload) {
  const schedule = await SchedulesRepository.findById(id);
  if (!schedule) return null;
  const job = await JobsRepository.findById(schedule.job_id);
  const settings = await readSettings();
  const zone = normalizeZone(payload.timezone || schedule.timezone || settings.timezone);
  const startIso = payload.start_at || schedule.start_at;
  const start = DateTime.fromISO(startIso, { zone });
  if (!start.isValid) throw new Error('Invalid start_at');
  const now = DateTime.now().setZone(zone);
  if (start.diff(now, 'minutes').minutes <= 1) {
    throw new Error('Schedule starts within 1 minute. Disable and recreate or use Run now.');
  }
  const endIso = payload.end_at === undefined ? schedule.end_at : payload.end_at;
  const end = endIso ? DateTime.fromISO(endIso, { zone }) : null;
  if (end && !end.isValid) throw new Error('Invalid end_at');
  if (end && end <= start) throw new Error('End must be after start');

  const openEndedError = await evaluateOpenEnded(job.loop_enabled, end);
  if (openEndedError) {
    await JobsRepository.updateStatus(job.id, 'invalid', openEndedError);
    await recordEvent({ event_type: 'session_blocked', message: openEndedError, job_id: job.id, schedule_id: schedule.id });
    throw new Error(openEndedError);
  }

  const asset = await AssetsRepository.findById(job.video_asset_id);
  const assetDuration = parseAssetDurationSeconds(asset);
  const durationSeconds = computeDurationSeconds(start, end);
  const durationError = validateDurationAgainstAsset(durationSeconds, assetDuration, job.loop_enabled);

  const updated = await SchedulesRepository.update(schedule.id, {
    start_at: start.toUTC().toISO(),
    end_at: end ? end.toUTC().toISO() : null,
    timezone: zone,
    enabled: payload.enabled === undefined ? schedule.enabled : payload.enabled,
  });

  await recordEvent({
    event_type: 'schedule_created',
    message: 'Schedule updated',
    job_id: job.id,
    schedule_id: schedule.id,
    metadata: { start_at: updated.start_at, end_at: updated.end_at, timezone: zone },
  });

  if (durationError) {
    await JobsRepository.updateStatus(job.id, 'invalid', durationError);
    await recordEvent({ event_type: 'session_blocked', message: durationError, job_id: job.id, schedule_id: schedule.id });
  } else {
    await refreshJobStatus(job.id);
  }
  return { schedule: updated, warning: durationError };
}

async function disableSchedule(id) {
  const schedule = await SchedulesRepository.disable(id);
  if (!schedule) return null;
  await recordEvent({
    event_type: 'schedule_disabled',
    message: 'Schedule disabled',
    job_id: schedule.job_id,
    schedule_id: schedule.id,
  });
  await refreshJobStatus(schedule.job_id);
  return schedule;
}

async function deleteSchedule(id) {
  const schedule = await SchedulesRepository.findById(id);
  if (!schedule) return null;
  await SchedulesRepository.delete(id);
  await refreshJobStatus(schedule.job_id);
  return schedule;
}

async function stopAllSessions() {
  const runningSessions = await SessionsRepository.findRunning();
  const stopped = [];
  for (const session of runningSessions) {
    const result = await stopSession(session.job_id, 'stop_all');
    if (result) stopped.push(result);
  }
  return stopped;
}

module.exports = {
  buildJobPayload,
  createJob,
  updateJob,
  runJobNow,
  stopSession,
  stopAllSessions,
  createSchedule,
  updateSchedule,
  disableSchedule,
  deleteSchedule,
  refreshJobStatus,
  recordEvent,
};
