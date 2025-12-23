PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password TEXT NOT NULL,
  avatar_path TEXT,
  gdrive_api_key TEXT,
  user_role TEXT DEFAULT 'admin',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  filepath TEXT NOT NULL,
  thumbnail_path TEXT,
  file_size INTEGER,
  duration REAL,
  format TEXT,
  resolution TEXT,
  bitrate INTEGER,
  fps TEXT,
  user_id TEXT,
  upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  video_id TEXT,
  rtmp_url TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  platform TEXT,
  platform_icon TEXT,
  bitrate INTEGER DEFAULT 2500,
  resolution TEXT,
  fps INTEGER DEFAULT 30,
  orientation TEXT DEFAULT 'horizontal',
  loop_video BOOLEAN DEFAULT 1,
  schedule_time TIMESTAMP,
  duration INTEGER,
  status TEXT DEFAULT 'offline',
  status_updated_at TIMESTAMP,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  use_advanced_settings BOOLEAN DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  user_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

CREATE TABLE IF NOT EXISTS stream_history (
  id TEXT PRIMARY KEY,
  stream_id TEXT,
  title TEXT NOT NULL,
  platform TEXT,
  platform_icon TEXT,
  video_id TEXT,
  video_title TEXT,
  resolution TEXT,
  bitrate INTEGER,
  fps INTEGER,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  duration INTEGER,
  use_advanced_settings BOOLEAN DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  user_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (stream_id) REFERENCES streams(id),
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_shuffle BOOLEAN DEFAULT 0,
  user_id TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS playlist_videos (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER,
  status TEXT DEFAULT 'ready',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS destinations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT DEFAULT 'youtube',
  stream_url TEXT NOT NULL,
  stream_key_enc TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  remux_enabled BOOLEAN DEFAULT 0,
  force_encode BOOLEAN DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  video_asset_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  preset_id TEXT,
  loop_enabled BOOLEAN DEFAULT 0,
  crossfade_seconds INTEGER,
  status TEXT DEFAULT 'idle',
  invalid_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_asset_id) REFERENCES assets(id),
  FOREIGN KEY (destination_id) REFERENCES destinations(id),
  FOREIGN KEY (preset_id) REFERENCES presets(id)
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  start_at TIMESTAMP NOT NULL,
  end_at TIMESTAMP,
  timezone TEXT NOT NULL,
  enabled BOOLEAN DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  schedule_id TEXT,
  status TEXT DEFAULT 'pending',
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  error TEXT,
  restart_count INTEGER DEFAULT 0,
  snapshot_stream_key_enc TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  FOREIGN KEY (schedule_id) REFERENCES schedules(id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  job_id TEXT,
  session_id TEXT,
  schedule_id TEXT,
  metadata_json TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (schedule_id) REFERENCES schedules(id)
);

CREATE TABLE IF NOT EXISTS log_parts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  content TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT DEFAULT 'UTC',
  language TEXT DEFAULT 'en',
  retention_days INTEGER DEFAULT 30,
  keep_forever BOOLEAN DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO settings (id, timezone, language, retention_days, keep_forever)
SELECT 1, 'UTC', 'en', 30, 0
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 1);
