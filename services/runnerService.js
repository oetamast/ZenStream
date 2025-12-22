const { spawn, execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { DateTime } = require('luxon');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const {
  AssetsRepository,
  DestinationsRepository,
  JobsRepository,
  PresetsRepository,
  SessionsRepository,
} = require('../db/repositories');
const { recordEvent } = require('./eventService');
const { refreshJobStatus } = require('./jobStatusService');
const { paths } = require('../utils/storage');
const { decryptSecret } = require('../utils/crypto');
const { buildRtmpTarget } = require('./destinationService');
const { readSettings } = require('./settingsService');

const running = new Map(); // session_id -> state
const retryTracker = new Map(); // session_id -> { count, nextAttempt, firstFailureAt }
const RETRY_BACKOFFS = [5, 10, 20, 40, 60, 120];
const OPEN_ENDED_RETRY_MINUTES = 30;
const POLL_INTERVAL_MS = 3000;
let loopHandle = null;
let ticking = false;

function maskTarget(target, key) {
  if (!target) return '';
  if (key) return target.replace(key, '***');
  const parts = target.split('/');
  if (parts.length > 3) {
    parts[parts.length - 1] = '***';
    return parts.join('/');
  }
  return target;
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

function ensureFfmpegLogDir() {
  const logDir = path.join(paths.logs, 'ffmpeg');
  fs.ensureDirSync(logDir);
  return logDir;
}

function getDiskFreeMegabytes() {
  try {
    const raw = execSync('df -Pm /data').toString().split('\n');
    const dataLine = raw.find((line) => line.includes('/data'));
    if (!dataLine) return null;
    const parts = dataLine.trim().split(/\s+/);
    const available = Number(parts[3]);
    return Number.isFinite(available) ? available : null;
  } catch (err) {
    return null;
  }
}

function buildLoopArgs(job, assetDuration, preset) {
  const args = ['-re'];
  if (job.loop_enabled) {
    args.push('-stream_loop', '-1');
  }
  return args;
}

function buildFilterComplex(job, assetDuration) {
  if (!job.loop_enabled || !job.crossfade_seconds) return null;
  if (!assetDuration || job.crossfade_seconds * 2 >= assetDuration) {
    return null;
  }
  const fade = job.crossfade_seconds;
  const startFadeOut = assetDuration - fade;
  const videoFade = `fade=t=in:st=0:d=${fade},fade=t=out:st=${startFadeOut}:d=${fade}`;
  const audioFade = `afade=t=in:st=0:d=${fade},afade=t=out:st=${startFadeOut}:d=${fade}`;
  return { videoFade, audioFade };
}

function buildCodecArgs(preset, hasFilter) {
  if (hasFilter || preset?.force_encode) {
    const videoCodec = preset?.video_codec || 'libx264';
    const audioCodec = preset?.audio_codec || 'aac';
    const args = ['-c:v', videoCodec];
    if (!preset?.video_codec || videoCodec === 'libx264') {
      args.push('-preset', 'veryfast', '-pix_fmt', 'yuv420p');
    }
    args.push('-c:a', audioCodec);
    return args;
  }
  return ['-c:v', 'copy', '-c:a', 'copy'];
}

async function buildFfmpegArgs(job, asset, destination, preset) {
  const inputPath = asset.path;
  const target = buildRtmpTarget(destination.stream_url, destination._stream_key_plain || '');
  const assetDuration = parseAssetDurationSeconds(asset);
  const loopArgs = buildLoopArgs(job, assetDuration, preset);
  const filter = buildFilterComplex(job, assetDuration);
  const args = ['-nostdin', ...loopArgs, '-i', inputPath];

  args.push(...buildCodecArgs(preset, !!filter));

  if (filter) {
    args.push('-vf', filter.videoFade, '-af', filter.audioFade);
  }

  args.push('-f', 'flv', target);
  return args;
}

function withinOpenEndedRetryWindow(session) {
  if (session.target_end_at) {
    const end = DateTime.fromISO(session.target_end_at, { zone: 'utc' });
    return end.isValid && DateTime.utc() < end;
  }
  const started = session.started_at
    ? DateTime.fromISO(session.started_at, { zone: 'utc' })
    : DateTime.utc();
  const elapsed = DateTime.utc().diff(started, 'minutes').minutes;
  return elapsed < OPEN_ENDED_RETRY_MINUTES;
}

async function markSessionFailed(session, message) {
  await SessionsRepository.updateStatus(session.id, 'failed', message);
  await recordEvent({
    event_type: 'session_failed',
    message: message || 'Session failed',
    job_id: session.job_id,
    session_id: session.id,
    metadata: { error: message },
  });
  await refreshJobStatus(session.job_id);
}

async function stopSessionProcess(session, reason = 'stopped') {
  const state = running.get(session.id);
  if (state && state.child && !state.stopRequested) {
    state.stopRequested = true;
    state.stopReason = reason;
    state.child.kill('SIGTERM');
    state.killTimer = setTimeout(() => {
      if (!state.child.killed) {
        state.child.kill('SIGKILL');
      }
    }, 5000);
    return { pendingKill: true };
  }

  await SessionsRepository.updateStatus(session.id, 'stopped', null, reason);
  await recordEvent({
    event_type: 'session_stopped',
    message: `Session stopped (${reason})`,
    job_id: session.job_id,
    session_id: session.id,
    metadata: { reason },
  });
  await refreshJobStatus(session.job_id);
  retryTracker.delete(session.id);
  running.delete(session.id);
  return { stopped: true };
}

async function handleExit(session, code, signal, state) {
  const exitMessage = `FFmpeg exited with code ${code}${signal ? ` signal ${signal}` : ''}`;
  if (state.killTimer) clearTimeout(state.killTimer);
  running.delete(session.id);

  await recordEvent({
    event_type: 'ffmpeg_exit',
    message: exitMessage,
    job_id: session.job_id,
    session_id: session.id,
    metadata: { code, signal }
  });

  if (state.stopRequested) {
    await SessionsRepository.updateStatus(session.id, 'stopped', null, state.stopReason || 'stopped');
    await recordEvent({
      event_type: 'session_stopped',
      message: `Session stopped (${state.stopReason || 'stopped'})`,
      job_id: session.job_id,
      session_id: session.id,
      metadata: { reason: state.stopReason || 'stopped' },
    });
    await refreshJobStatus(session.job_id);
    retryTracker.delete(session.id);
    return;
  }

  if (code === 0) {
    await SessionsRepository.updateStatus(session.id, 'stopped', null, 'natural_end');
    await recordEvent({
      event_type: 'session_stopped',
      message: 'Session completed',
      job_id: session.job_id,
      session_id: session.id,
      metadata: { reason: 'natural_end' },
    });
    await refreshJobStatus(session.job_id);
    retryTracker.delete(session.id);
    return;
  }

  const retryState = retryTracker.get(session.id) || { count: 0, firstFailureAt: DateTime.utc() };
  if (!withinOpenEndedRetryWindow(session)) {
    await recordEvent({
      event_type: 'retry_gave_up',
      message: 'Retry window closed, giving up',
      job_id: session.job_id,
      session_id: session.id,
    });
    await markSessionFailed(session, exitMessage);
    retryTracker.delete(session.id);
    return;
  }

  const delay = RETRY_BACKOFFS[Math.min(retryState.count, RETRY_BACKOFFS.length - 1)];
  retryState.count += 1;
  retryState.nextAttempt = DateTime.utc().plus({ seconds: delay });
  retryTracker.set(session.id, retryState);
  await SessionsRepository.updateStatus(session.id, 'pending', exitMessage);
  await SessionsRepository.incrementRestartCount(session.id);
  await recordEvent({
    event_type: 'retry_scheduled',
    message: `Retrying in ${delay} seconds`,
    job_id: session.job_id,
    session_id: session.id,
    metadata: { delay_seconds: delay, attempt: retryState.count }
  });
}

async function startFfmpeg(session) {
  const job = await JobsRepository.findById(session.job_id);
  if (!job) {
    await markSessionFailed(session, 'Job missing for session');
    return;
  }
  const asset = await AssetsRepository.findById(job.video_asset_id);
  if (!asset) {
    await markSessionFailed(session, 'Asset missing for session');
    return;
  }
  const destination = await DestinationsRepository.findById(job.destination_id);
  if (!destination) {
    await JobsRepository.updateStatus(job.id, 'invalid', 'Destination missing');
    await recordEvent({
      event_type: 'session_blocked',
      message: 'Destination missing',
      job_id: job.id,
      session_id: session.id,
    });
    await markSessionFailed(session, 'Destination missing');
    return;
  }
  if (!/^rtmps?:\/\//i.test(destination.stream_url || '')) {
    await recordEvent({
      event_type: 'session_blocked',
      message: 'Destination URL invalid',
      job_id: job.id,
      session_id: session.id,
    });
    await JobsRepository.updateStatus(job.id, 'invalid', 'Destination URL invalid');
    await markSessionFailed(session, 'Destination URL invalid');
    return;
  }
  let streamKeyPlain = '';
  try {
    streamKeyPlain = decryptSecret(destination.stream_key_enc || '');
  } catch (err) {
    await recordEvent({
      event_type: 'session_blocked',
      message: 'Destination key could not be decrypted',
      job_id: job.id,
      session_id: session.id,
    });
    await JobsRepository.updateStatus(job.id, 'invalid', 'Destination key invalid');
    await markSessionFailed(session, 'Destination key invalid');
    return;
  }
  const existingRunning = await SessionsRepository.findRunningByJob(job.id);
  if (existingRunning && existingRunning.id !== session.id) {
    await recordEvent({
      event_type: 'session_blocked',
      message: 'Another session already running for this job',
      job_id: job.id,
      session_id: session.id,
    });
    await SessionsRepository.updateStatus(session.id, 'failed', 'Concurrent session blocked');
    return;
  }

  if (session.target_end_at) {
    const end = DateTime.fromISO(session.target_end_at, { zone: 'utc' });
    if (end.isValid && DateTime.utc() >= end) {
      await recordEvent({
        event_type: 'session_blocked',
        message: 'Session window already closed',
        job_id: job.id,
        session_id: session.id,
      });
      await SessionsRepository.updateStatus(session.id, 'failed', 'Session window closed');
      await refreshJobStatus(job.id);
      return;
    }
  }

  const freeMb = getDiskFreeMegabytes();
  if (freeMb !== null && freeMb < 100) {
    await recordEvent({
      event_type: 'session_blocked',
      message: 'Insufficient disk space under /data',
      job_id: job.id,
      session_id: session.id,
    });
    await SessionsRepository.updateStatus(session.id, 'failed', 'Low disk');
    await refreshJobStatus(job.id);
    return;
  }

  destination._stream_key_plain = streamKeyPlain;
  const preset = job.preset_id ? await PresetsRepository.findById(job.preset_id) : null;
  const settings = await readSettings();

  if (settings.safety_cap_enabled && settings.benchmark_profile && preset?.force_encode) {
    await recordEvent({
      event_type: 'safety_cap_warning',
      message: `Force encode requested under safety profile ${settings.benchmark_profile}`,
      job_id: job.id,
      session_id: session.id,
      metadata: { benchmark_profile: settings.benchmark_profile },
    });
  }

  const ffmpegArgs = await buildFfmpegArgs(job, asset, destination, preset);
  const logDir = ensureFfmpegLogDir();
  const logPath = path.join(logDir, `session_${session.id}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const child = spawn(ffmpegInstaller.path, ffmpegArgs);
  const state = {
    session,
    job,
    logPath,
    child,
    stopRequested: false,
    stopReason: null,
    killTimer: null,
  };
  running.set(session.id, state);

  child.stdout.on('data', (data) => logStream.write(data));
  child.stderr.on('data', (data) => logStream.write(data));
  child.on('exit', async (code, signal) => {
    logStream.end();
    await handleExit(session, code, signal, state);
  });

  await SessionsRepository.markRunning(session.id, DateTime.utc().toISO(), logPath);
  await recordEvent({
    event_type: 'ffmpeg_started',
    message: `FFmpeg started for job ${job.name}`,
    job_id: job.id,
    session_id: session.id,
    metadata: {
      target: maskTarget(
        buildRtmpTarget(destination.stream_url, destination._stream_key_plain || ''),
        destination._stream_key_plain || ''
      ),
      loop_enabled: !!job.loop_enabled,
      preset: preset?.name || null,
    }
  });
  retryTracker.delete(session.id);
}

async function startPendingSessions() {
  const pending = await SessionsRepository.findPending();
  const now = DateTime.utc();
  for (const session of pending) {
    const retryState = retryTracker.get(session.id);
    if (retryState && retryState.nextAttempt && now < retryState.nextAttempt) {
      continue;
    }
    if (running.has(session.id)) continue;
    await startFfmpeg(session);
  }
}

async function stopSessionsPastWindow() {
  const now = DateTime.utc();
  for (const [sessionId, state] of running.entries()) {
    const session = state.session;
    if (session.target_end_at) {
      const end = DateTime.fromISO(session.target_end_at, { zone: 'utc' });
      if (end.isValid && now >= end) {
        await stopSessionProcess(session, 'schedule_end');
      }
    }
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await startPendingSessions();
    await stopSessionsPastWindow();
  } catch (err) {
    console.error('Runner tick error', err.message);
  } finally {
    ticking = false;
  }
}

async function startRunner() {
  if (loopHandle) return;
  await tick();
  loopHandle = setInterval(tick, POLL_INTERVAL_MS);
  console.log('ZenStream runner started');
}

function stopRunner() {
  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
  }
}

module.exports = {
  startRunner,
  stopRunner,
  stopSessionProcess,
};
