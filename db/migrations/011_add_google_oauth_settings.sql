ALTER TABLE settings ADD COLUMN google_client_id TEXT;
ALTER TABLE settings ADD COLUMN google_client_secret_enc TEXT;
ALTER TABLE settings ADD COLUMN google_redirect_uri TEXT;
ALTER TABLE settings ADD COLUMN google_access_token_enc TEXT;
ALTER TABLE settings ADD COLUMN google_refresh_token_enc TEXT;
ALTER TABLE settings ADD COLUMN google_token_expiry INTEGER;
