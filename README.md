# ZenStream

ZenStream is a container-first fork of the StreamFlow project that keeps the core streaming dashboard while simplifying deployment.
FFmpeg is bundled in the image and the app exposes a lightweight health probe for infrastructure checks.

## Quickstart

```bash
docker compose up -d --build
```

Open `http://<ip>:6969` once the containers are running.

> Tip: run `npm run generate-secret` to create a `.env` file with `SESSION_SECRET` if you do not already have one.

## Data directories

ZenStream writes persistent data under `/data` (overridable with `DATA_DIR`). Ensure the following paths are available to the container:

- `/data/assets/videos`
- `/data/assets/audios`
- `/data/assets/sfx`
- `/data/assets/avatars`
- `/data/thumbs`
- `/data/logs`

Mount a host directory to `/data` in `docker-compose.yml` to preserve uploads and logs.

## Development notes

- Default port: `6969` (configurable via `PORT`).
- Health endpoints: `/health` and `/api/health` return `200 OK` when the server is ready.
- FFmpeg is preinstalled in the container for thumbnailing and media processing.

## Attribution & License

Based on [bangtutorial/streamflow](https://github.com/bangtutorial/streamflow) (MIT).
See [LICENSE.md](LICENSE.md) for the full license text.
