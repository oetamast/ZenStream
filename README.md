# ZenStream

ZenStream is a container-first fork of the StreamFlow project that keeps the core streaming dashboard while simplifying deployment.
FFmpeg is bundled in the image and the app exposes a lightweight health probe for infrastructure checks.

## Quickstart

```bash
docker compose up -d --build
```

Open `http://<ip>:6969` once the containers are running.

> Tip: run `npm run generate-secret` to create a `.env` file with `SESSION_SECRET` if you do not already have one.

> Secrets: set `INSTALL_SECRET` (or reuse `SESSION_SECRET`) to encrypt stored stream keys. Both values can live in `.env`.

## Data directories

ZenStream writes persistent data under `/data` (overridable with `DATA_DIR`). Ensure the following paths are available to the container:

- `/data/assets/videos`
- `/data/assets/audios`
- `/data/assets/sfx`
- `/data/assets/avatars`
- `/data/assets/thumbs`
- `/data/logs`

Mount a host directory to `/data` in `docker-compose.yml` to preserve uploads and logs.

### Assets

- Upload up to **500MB** per file via `POST /api/assets/upload` (multipart fields: `file`, `asset_type` as `video|audio|sfx`).
- Files are stored under `/data/assets/<type>` and analyzed automatically with `ffprobe`; thumbnails for videos are saved to `/data/assets/thumbs` and served at `/api/assets/:id/thumbnail`.
- Search by filename only with `GET /api/assets?type=video&query=<substring>` (results are newest first).
- Import from a public Google Drive link via `POST /api/assets/import/google-drive` (`share_url`, `asset_type`).

### Destinations (YouTube RTMP/RTMPS)

- Create a destination via `POST /api/destinations` with `name`, `stream_url`, `stream_key` (platform defaults to `youtube`).
- `stream_url` must start with `rtmp://` or `rtmps://`. If the URL already contains your key path, you may leave `stream_key` empty; otherwise the final publish URL is built as `<stream_url>/<stream_key>`.
- Retrieve destinations with `GET /api/destinations` or `GET /api/destinations/:id` — responses only expose `has_stream_key` for safety.
- Reveal the key on demand via `POST /api/destinations/:id/reveal` (intended for authenticated callers).

## Development notes

- Default port: `6969` (configurable via `PORT`).
- Health endpoints: `/health` and `/api/health` return `200 OK` when the server is ready.
- FFmpeg is preinstalled in the container for thumbnailing and media processing.

## Attribution & License

Based on [bangtutorial/streamflow](https://github.com/bangtutorial/streamflow) (MIT).
See [LICENSE.md](LICENSE.md) for the full license text.
