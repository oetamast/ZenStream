ALTER TABLE settings ADD COLUMN telegram_enabled BOOLEAN DEFAULT 0;
ALTER TABLE settings ADD COLUMN telegram_bot_token_enc TEXT;
ALTER TABLE settings ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE settings ADD COLUMN telegram_events_json TEXT;

UPDATE settings
SET telegram_events_json = '{"stream_start":1,"stream_stop":1,"stream_fail":1,"retry_gave_up":1,"license_fail":1,"license_grace_started":1,"license_grace_ended":1}'
WHERE id = 1 AND telegram_events_json IS NULL;
