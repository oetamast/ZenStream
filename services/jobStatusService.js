const { DateTime } = require('luxon');
const { JobsRepository, SchedulesRepository, SessionsRepository } = require('../db/repositories');

async function refreshJobStatus(jobId) {
  const job = await JobsRepository.findById(jobId);
  if (!job) return null;
  if (job.invalid_reason) {
    await JobsRepository.updateStatus(job.id, 'invalid', job.invalid_reason);
    return 'invalid';
  }
  const running = await SessionsRepository.findRunningByJob(jobId);
  if (running) {
    await JobsRepository.updateStatus(jobId, 'running', null);
    return 'running';
  }
  const nowUtcIso = DateTime.utc().toISO();
  const nextSchedule = await SchedulesRepository.findNextEnabled(jobId, nowUtcIso);
  if (nextSchedule) {
    await JobsRepository.updateStatus(jobId, 'planned', null);
    return 'planned';
  }
  const hasHistory = await SessionsRepository.hasHistory(jobId);
  const status = hasHistory ? 'stopped' : 'idle';
  await JobsRepository.updateStatus(jobId, status, null);
  return status;
}

module.exports = { refreshJobStatus };
