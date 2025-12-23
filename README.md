# ZenStream

ZenStream is a container-first fork of the StreamFlow project that keeps the core streaming dashboard while simplifying deployment.
FFmpeg is bundled in the image and the app exposes a lightweight health probe for infrastructure checks.

## Quickstart

Run the included installer from the repo root on a fresh Ubuntu/Debian VPS:

```bash
sudo bash ./install.sh
```

The installer will:

- Update apt packages and install Node.js 22.x, FFmpeg, Git, UFW, and PM2.
- Create `/data` directories (`db`, `assets`, `logs`, `config`, `ffmpeg`).
- Generate a persistent `SESSION_SECRET` (stored in `/data/config/session_secret`) if one is not provided and write a `.env` with `PORT=6969`, `DATA_DIR=/data`, `SESSION_SECRET`, and `INSTALL_SECRET`.
- Start ZenStream with PM2 on port 6969, saving the process under the `zenstream` name.

Then open `http://<ip>:6969` to finish the setup wizard (first visit redirects to `/setup`).

> Secrets: set `INSTALL_SECRET` (or reuse `SESSION_SECRET`) to encrypt stored stream keys. Both values live in `.env`; the installer seeds both with the same random value. If `SESSION_SECRET` is not set, ZenStream will persist one at `/data/config/session_secret` so sessions stay valid across restarts. You can also start from `.env.example` and override `SESSION_SECRET` manually.

### First-run setup & login

- On first launch, all requests redirect to `/setup` until an admin user exists.
- Create the admin username/password plus timezone/language/retention defaults, then you will be sent to `/login`.
- All app pages and `/api/*` (except `/api/health`) require login. Update your password later from **Settings → Security**.

### PM2 (manual start)

If you run ZenStream directly with PM2 instead of Docker, ensure `SESSION_SECRET` is provided (or read the generated `/data/config/session_secret`):

```bash
PORT=6969 SESSION_SECRET=$(cat /data/config/session_secret 2>/dev/null || echo "changeme") pm2 start app.js --name zenstream --update-env
```

### Web UI basics

- **Streams**: create jobs by selecting a video asset, destination, and preset, then start via Run Now (duration or schedule window).
- **Assets**: upload up to 500MB, view analyzed metadata and thumbnails, and trigger re-analysis when needed.
- **Destinations**: add YouTube RTMP/RTMPS targets, store stream keys safely, and reveal keys on demand.
- **Presets**: choose copy/remux (default) or encode (with optional codecs) for FFmpeg sessions.
- **History**: view recent events and open FFmpeg logs per session.

### First Stream (end-to-end)

1. Go to **Destinations** → **New Destination** and enter your YouTube RTMP/RTMPS URL plus stream key (keep key separate from the URL for safety).
2. Go to **Assets** → **Upload video** (max 500MB). Wait for analysis to finish; a thumbnail should appear.
3. Go to **Presets** and keep the default **Copy/Remux** preset (or create one if you prefer encoding).
4. Go to **Streams** → **New Stream**, name it, select the uploaded video, the destination, and your preset, then save.
5. Click **Run now** on the stream card. The status should flip to **running** once FFmpeg starts.
6. To stop, click **Stop** on the stream card.
7. Open **History** to see recent events and use **View log** to read the FFmpeg output for the session.

## Data directories

ZenStream writes persistent data under `/data` (overridable with `DATA_DIR`). Ensure the following paths are available to the container:

- `/data/assets/videos`
- `/data/assets/audios`
- `/data/assets/sfx`
- `/data/assets/avatars`
- `/data/assets/thumbs`
- `/data/logs`

Mount a host directory to `/data` in `docker-compose.yml` to preserve uploads and logs.

### Logs & retention

- History events and FFmpeg session logs live under `/data/logs` (FFmpeg logs are in `/data/logs/ffmpeg`).
- By default, ZenStream keeps logs for **30 days** and auto-cleans on boot and every few hours.
- Adjust retention or enable **Keep forever** from **Settings**; when enabled, countdown labels disappear in History.

### Assets

- Upload up to **500MB** per file via `POST /api/assets/upload` (multipart fields: `file`, `asset_type` as `video|audio|sfx`).
- Files are stored under `/data/assets/<type>` and analyzed automatically with `ffprobe`; thumbnails for videos are saved to `/data/assets/thumbs` and served at `/api/assets/:id/thumbnail`.
- Search by filename only with `GET /api/assets?type=video&query=<substring>` (results are newest first).
- Google Drive import:
  - Public share links do **not** require OAuth. Use the Assets page “Import from Google Drive” button or call `POST /api/assets/google-drive/import` with `share_url` + `asset_type`.
  - Private links require OAuth: set client ID/secret and redirect URL (e.g., `http://<host>:6969/api/assets/google-drive/auth/callback`) in **Settings → Google Drive**, then click **Connect Google Drive**. Tokens are encrypted at rest.
  - Check status with `GET /api/assets/google-drive/status/:id`; events log successes/failures.

### Destinations (YouTube RTMP/RTMPS)

- Create a destination via `POST /api/destinations` with `name`, `stream_url`, `stream_key` (platform defaults to `youtube`).
- `stream_url` must start with `rtmp://` or `rtmps://`. If the URL already contains your key path, you may leave `stream_key` empty; otherwise the final publish URL is built as `<stream_url>/<stream_key>`.
- Retrieve destinations with `GET /api/destinations` or `GET /api/destinations/:id` — responses only expose `has_stream_key` for safety.
- Reveal the key on demand via `POST /api/destinations/:id/reveal` (intended for authenticated callers).

### Presets

- Manage presets with `GET/POST/PUT/DELETE /api/presets` and attach them to jobs via `preset_id`.
- Default behavior is **remux/copy** for fast uploads with minimal CPU. Set `force_encode=true` to transcode (uses `libx264` + `aac` unless you provide specific codecs).
- `remux_enabled` and `force_encode` are mutually exclusive; enabling encode uses more CPU — prefer remux for typical MP4 → YouTube RTMP workflows.

### Telegram alerts

- Configure from **Settings → Telegram alerts** or via `GET/PUT /api/settings`.
- Fields: master enable, bot token (masked on load), chat ID, and per-event toggles.
- Defaults ON: stream start/stop (manual), stream fail, retry gave up, license fail, license grace start/end. Others default OFF.
- Test delivery with `POST /api/settings/telegram/test` (uses saved token/chat by default).
- Setup steps: create a bot with **BotFather**, copy the token, find your chat ID (e.g., with @userinfobot or a channel’s numeric ID), paste both into Settings, save, and run the test.

### License tier (scaffolding)

- Select **Basic/Premium/Ultimate** in Settings or via `PUT /api/settings` with `license_tier`.
- This is a local stub for development; premium/ultimate controls remain disabled until the tier is raised.
- Retry behavior is gated: **Basic = no retry on FFmpeg failure**, **Premium/Ultimate = retry within the schedule/run window** (emitting `retry_gave_up` when the window closes).
- Premium/Ultimate endpoints reject requests with `{ error: "requires_premium"|"requires_ultimate" }` and respond `501 Not Implemented` when the tier allows but the feature is not yet available.

## Development notes

- Default port: `6969` (configurable via `PORT`).
- Health endpoints: `/health` and `/api/health` return `200 OK` when the server is ready.
- FFmpeg is preinstalled in the container for thumbnailing and media processing.

## Attribution & License

Based on [bangtutorial/streamflow](https://github.com/bangtutorial/streamflow) (MIT).
See [LICENSE.md](LICENSE.md) for the full license text.
