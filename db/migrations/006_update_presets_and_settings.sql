-- Add codec fields and updated timestamp to presets
ALTER TABLE presets ADD COLUMN video_codec TEXT;
ALTER TABLE presets ADD COLUMN audio_codec TEXT;
ALTER TABLE presets ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Normalize default remux flag where missing
UPDATE presets SET remux_enabled = 1 WHERE remux_enabled IS NULL;

-- Extend settings with safety caps placeholders
ALTER TABLE settings ADD COLUMN safety_cap_enabled BOOLEAN DEFAULT 0;
ALTER TABLE settings ADD COLUMN benchmark_profile TEXT DEFAULT 'safe';
