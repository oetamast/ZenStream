ALTER TABLE settings ADD COLUMN setup_completed BOOLEAN DEFAULT 0;
UPDATE settings SET setup_completed = COALESCE(setup_completed, 0) WHERE id = 1;
