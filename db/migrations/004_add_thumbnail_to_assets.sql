PRAGMA foreign_keys = ON;

ALTER TABLE assets ADD COLUMN thumbnail_path TEXT;

CREATE INDEX IF NOT EXISTS idx_assets_filename ON assets(filename);
