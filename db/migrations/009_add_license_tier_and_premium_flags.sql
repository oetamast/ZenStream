ALTER TABLE settings ADD COLUMN license_tier TEXT DEFAULT 'basic';

ALTER TABLE jobs ADD COLUMN auto_recovery_enabled BOOLEAN DEFAULT 0;
ALTER TABLE jobs ADD COLUMN audio_replace_config TEXT;
ALTER TABLE jobs ADD COLUMN hot_swap_mode TEXT;
ALTER TABLE jobs ADD COLUMN scenes_json TEXT;
ALTER TABLE jobs ADD COLUMN swap_rules_json TEXT;
