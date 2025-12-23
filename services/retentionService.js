const fs = require('fs-extra');
const path = require('path');
const { DateTime } = require('luxon');
const { EventsRepository, LogPartsRepository, SessionsRepository } = require('../db/repositories');
const { readSettings } = require('./settingsService');
const { paths } = require('../utils/storage');

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let cleanupTimer = null;
let cleanupInFlight = false;

function normalizeRetentionSettings(settings) {
  const keepForever = Boolean(settings.keep_forever);
  let days = Number(settings.retention_days);
  if (!Number.isFinite(days)) days = 30;
  days = Math.max(1, Math.min(3650, Math.round(days)));
  return { keepForever, retentionDays: days };
}

async function cleanupEvents(cutoffSql, runningSessionIds) {
  await EventsRepository.deleteOlderThan(cutoffSql, runningSessionIds);
  await LogPartsRepository.deleteOlderThan(cutoffSql, runningSessionIds);
}

async function cleanupLogs(logRoot, cutoffDateTime, runningSessionIds) {
  const ffmpegDir = path.join(logRoot, 'ffmpeg');
  await fs.ensureDir(ffmpegDir);
  const files = await fs.readdir(ffmpegDir);
  // Never delete logs newer than 24h and skip logs tied to running sessions
  const safeThreshold = DateTime.max(cutoffDateTime, DateTime.utc().minus({ hours: 24 }));

  for (const file of files) {
    const full = path.join(ffmpegDir, file);
    const stat = await fs.stat(full);
    const modified = DateTime.fromJSDate(stat.mtime);
    if (!modified.isValid || modified > safeThreshold) continue;

    const sessionMatch = file.match(/session_([a-f0-9\-]+)\.log$/i);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      if (runningSessionIds.includes(sessionId)) continue;
    }

    try {
      await fs.remove(full);
    } catch (err) {
      console.error('Failed to remove old log', file, err.message);
    }
  }
}

async function runCleanup() {
  if (cleanupInFlight) return;
  cleanupInFlight = true;
  try {
    const settings = await readSettings();
    const policy = normalizeRetentionSettings(settings);
    if (policy.keepForever) return;

    const cutoff = DateTime.utc().minus({ days: policy.retentionDays });
    const cutoffSql = cutoff.toSQL({ includeZone: false });
    const runningSessions = await SessionsRepository.findRunning();
    const runningSessionIds = (runningSessions || []).map((s) => s.id);

    await cleanupEvents(cutoffSql, runningSessionIds);
    await cleanupLogs(paths.logs, cutoff, runningSessionIds);
  } catch (err) {
    console.error('Retention cleanup error:', err.message);
  } finally {
    cleanupInFlight = false;
  }
}

function startRetentionCleanup() {
  if (cleanupTimer) return;
  runCleanup();
  cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
}

module.exports = {
  startRetentionCleanup,
  runCleanup,
  normalizeRetentionSettings,
};
