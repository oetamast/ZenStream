# ZenStream v1 Basic Recon and Plan

- **Database**: SQLite stored at `/data/db/zenstream.sqlite` (ensured at startup) via `db/database.js` with a migration runner (`db/migrations/*`). Baseline tables cover legacy StreamFlow entities (`users`, `videos`, `streams`, `stream_history`, `playlists`, `playlist_videos`) plus new ZenStream v1 Basic entities (`assets`, `destinations`, `presets`, `jobs`, `schedules`, `sessions`, `events`, `log_parts`, `settings`). Legacy models in `models/` (`User.js`, `Video.js`, `Stream.js`, `Playlist.js`) still wrap direct SQL queries; new repository helpers live in `db/repositories.js`.
- **Routes**: The Express app is defined primarily in `app.js`. It configures middleware, session, CSRF, static assets, authentication, and all existing page/API routes in one file. Stub API routers exist for upcoming ZenStream endpoints in `routes/api*.js`.
- **Streams/Jobs Representation**: "Streams" are stored in the `streams` table and managed by `models/Stream.js`. Records include video reference, RTMP URL/key, platform metadata, bitrate/resolution/fps, loop flag, schedule time, duration, and status timestamps. Playlists are also treated as streamable sources via `video_id` pointing at a playlist.
- **ffmpeg Usage and Lifecycle**:
  - Video analysis/thumbnail generation uses `fluent-ffmpeg` in `utils/videoProcessor.js` (driven by `@ffmpeg-installer/ffmpeg`).
  - Live streaming uses `child_process.spawn` in `services/streamingService.js`, selecting system ffmpeg if present or bundled installer otherwise. It builds concat playlists for videos/playlists, tracks active processes in `activeStreams`, logs in memory, retries with limits, and cleans up process/log maps when stopping. Scheduler hooks live in `services/schedulerService.js`.
- **Uploads and /data Usage**: Upload middleware in `middleware/uploadMiddleware.js` stores videos and avatars on disk using paths from `utils/storage.js`. `utils/storage.js` points storage to `/data/assets/videos`, `/data/assets/audios`, `/data/assets/sfx`, `/data/assets/avatars`, `/data/thumbs`, and `/data/logs`, creating directories at startup via `ensureDirectories()` in `app.js`. Static serving for uploads uses these paths via `/uploads/...` routes.

## Minimalist Plan to Reach ZenStream v1 Basic
The goal is to add a schedulable single-destination job model with session tracking, asset/destination/preset management, history/log retention, and tier-aware gating, while keeping implementation incremental.

### Data Model Additions (new tables/models)
1. **assets**: Normalize media library (id, filename, type [video/audio/sfx], original_name, size_bytes, duration_sec, mime, path, thumb_path, created_at, updated_at, user_id).
2. **destinations**: Store RTMP/RTMPS endpoints (id, name, platform, stream_url, stream_key, created_at, updated_at, user_id, last_used_at).
3. **presets** (optional use per job): Encoding/runtime preferences (id, name, resolution, bitrate_kbps, fps, orientation, crossfade_sec, created_at, updated_at, user_id).
4. **jobs**: Core entity replacing legacy streams (id, name, asset_id, destination_id, preset_id nullable, loop boolean, crossfade_sec, status, status_updated_at, recommended_unique_name flag?).
5. **schedules**: One schedule per job (id, job_id, mode ['duration','window'], start_at, end_at nullable, duration_minutes nullable, timezone, locked boolean when <1 minute away, created_at, updated_at).
6. **sessions**: Runtime executions (id, job_id, schedule_id nullable, status [planned/running/stopped/failed], started_at, ended_at, stop_reason, rtmp_url_cached, retry_count, created_at).
7. **events/history**: Log user-visible events (id, job_id nullable, session_id nullable, type, message, severity, created_at, delete_after_at for retention countdown).
8. **settings**: Singleton row stored in the DB (id=1) with timezone, language, retention_days, keep_forever, and future tier fields; surfaced through a settings service backed by `settings` table.

### API Surface (new routes/endpoints)
- `POST/GET/PUT/DELETE /api/assets` (upload/list/delete/search by filename, ffprobe+thumbnail analysis; enforce 500MB cap).
- `POST/GET/PUT/DELETE /api/destinations` (CRUD with stream_key masking/reveal; block multi-destination).
- `POST/GET/PUT/DELETE /api/presets` (optional encoding presets; Premium gating stubbed as needed).
- `POST/GET/PUT/DELETE /api/jobs` (create/update/delete jobs with single destination and asset validation; warn on duplicate names; loop+crossfade rules; schedule association hooks).
- `POST/GET/PUT/DELETE /api/schedules` (attach schedule to job; validate future start, lock near-start, open-ended requires loop; duplicate allowed).
- `POST/GET/PUT/DELETE /api/sessions` (run-now or stop endpoints; stop-all; retry bookkeeping; end-of-window enforcement).
- `GET /api/history` (list events with retention countdown, delete if allowed; supports filter tabs).
- `GET/PUT /api/settings` (timezone, language, retention_days, tier, telegram toggles stub; 403 on premium-only fields when tier=Basic).

### UI Templates / Pages to Add or Modify
- **Streams** (`views/streams` + navigation tabs): Show Running/Planned/Stopped/All/Fix required with cards (thumbnail/name/schedule/status, expand actions start/stop/stop-all). Render validation warnings (schedule longer than asset w/o loop).
- **Assets**: Upload/search by filename, show duration/size/thumb from ffprobe, warn on schedule-duration mismatch; delete flow lists impacted jobs before confirmation.
- **Destinations**: CRUD with masked stream_key and reveal toggle; single destination selection per job.
- **Presets**: Optional settings; greyed/"Coming soon" elements for premium-only pieces.
- **History**: Event list with “deletes in X days” label honoring retention_days/forever toggle.
- **Settings**: Form for timezone, language (EN/ID), retention_days/keep forever, telegram alert defaults, and tier display with disabled premium/ultimate controls labeled “Coming soon”.

### Features to Remove/Ignore from StreamFlow
- Drop multi-destination/multi-output support; enforce one destination per job.
- Ignore playlist-as-stream input for now; jobs reference a single asset instead.
- Omit advanced auto-recovery/premium runner behaviors; Basic only retries within window.
- Skip multi-role/user features beyond existing admin login flow.

### Incremental Implementation Steps
1. Add schema migration for new tables/models and wire lightweight ORM helpers (similar style to existing models).
2. Implement asset ingestion: upload endpoint with 500MB cap, ffprobe metadata + thumbnail saved to `/data/assets/*` and `/data/thumbs`.
3. Build destination CRUD with masked keys; update UI page.
4. Introduce job model + schedule validation (future start, loop requirements, lock near start) and single-destination enforcement.
5. Add session runner layer reusing streamingService; emit event records for start/stop/fail and integrate stop-all.
6. Implement history listing with retention countdown and cleanup respecting `retention_days`/forever setting.
7. Wire settings persistence (timezone/language/retention_days/tier) and apply tier gating both backend (403 for premium fields) and frontend (disabled UI with “Coming soon”).
8. Localize key UI strings to English/Indonesian using existing i18n pattern.

## Settings Storage Decision
Settings now live in the SQLite `settings` table (id=1) seeded via migrations with defaults (`timezone` UTC, `language` en, `retention_days` 30, `keep_forever` false). The `settingsService` reads/writes through the DB-backed repository.
