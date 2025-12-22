-- Add enabled flag to jobs
ALTER TABLE jobs ADD COLUMN enabled BOOLEAN DEFAULT 1;
