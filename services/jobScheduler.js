const { DateTime } = require('luxon');
const {
  SchedulesRepository,
  JobsRepository,
  SessionsRepository,
} = require('../db/repositories');
const { readSettings } = require('./settingsService');
const {
  runJobNow,
  refreshJobStatus,
  stopSession,
} = require('./jobService');
const { recordEvent } = require('./eventService');

let schedulerInterval = null;
let isRunningTick = false;

async function handleDueSchedules() {
  const nowUtcIso = DateTime.utc().toISO();
  const due = await SchedulesRepository.listDue(nowUtcIso);
  for (const schedule of due) {
    const job = await JobsRepository.findById(schedule.job_id);
    if (!job) continue;
    if (job.invalid_reason) {
      await recordEvent({
        event_type: 'session_blocked',
        message: job.invalid_reason,
        job_id: job.id,
        schedule_id: schedule.id,
      });
      continue;
    }
    try {
      await runJobNow(job.id, {
        end_at: schedule.end_at,
        timezone: schedule.timezone,
        start_at_override: schedule.start_at,
      });
      await refreshJobStatus(job.id);
    } catch (err) {
      await recordEvent({
        event_type: 'session_blocked',
        message: err.message,
        job_id: job.id,
        schedule_id: schedule.id,
      });
    }
  }
}

async function stopExpiredSessions() {
  const now = DateTime.utc();
  const running = await SessionsRepository.findRunning();
  for (const session of running) {
    if (session.target_end_at) {
      const end = DateTime.fromISO(session.target_end_at, { zone: 'utc' });
      if (end.isValid && now >= end) {
        await stopSession(session.job_id, 'schedule_end');
      }
    }
  }
}

async function tick() {
  if (isRunningTick) return;
  isRunningTick = true;
  try {
    await handleDueSchedules();
    await stopExpiredSessions();
  } catch (err) {
    console.error('Scheduler tick failed', err.message);
  } finally {
    isRunningTick = false;
  }
}

async function startScheduler() {
  if (schedulerInterval) return;
  const settings = await readSettings();
  console.log(`Starting ZenStream basic scheduler with timezone ${settings.timezone}`);
  schedulerInterval = setInterval(tick, 10000);
  await tick();
}

function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
};
