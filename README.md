# Save2Telegram

[![Build](https://github.com/JerryLocke/Save2Telegram/actions/workflows/build.yml/badge.svg)](https://github.com/JerryLocke/Save2Telegram/actions/workflows/build.yml)
[![Latest Release](https://img.shields.io/github/v/release/JerryLocke/Save2Telegram?sort=semver)](https://github.com/JerryLocke/Save2Telegram/releases/latest)
[![GHCR](https://img.shields.io/badge/image-ghcr.io%2Fjerrylocke%2Fsave2telegram--backend-blue)](https://github.com/JerryLocke/Save2Telegram/pkgs/container/save2telegram-backend)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文文档](README.zh-CN.md)

Save2Telegram is a Chrome MV3 extension for forwarding media from X/Twitter posts to a Telegram channel through a Telegram Bot. It can run entirely inside the extension service worker, or use the optional Node.js backend to handle media download and Telegram upload outside the browser.

## Project Structure

- `crx/`: Chrome extension source.
- `backend/`: Optional Node.js forwarding backend with Docker support.

## Install the Extension

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `crx/` directory from this repository.

## Configure Telegram

1. Create a bot with BotFather and copy the bot token.
2. Add the bot as an administrator of the target Telegram channel.
3. Open the extension popup.
4. Add a Telegram config with the bot token and channel ID or public `@username`.
5. For private channels, use the numeric channel ID that starts with `-100`.

## Docker Deployment

Pull and run the backend image from GHCR:

```bash
docker pull ghcr.io/jerrylocke/save2telegram-backend:latest
docker run -d --name save2telegram-backend -p 18080:3000 \
  -v save2telegram-data:/app/data \
  ghcr.io/jerrylocke/save2telegram-backend:latest \
  --public-url http://localhost:18080
```

Docker arguments:

- `--name save2telegram-backend`: Names the container. Restart it later with `docker restart save2telegram-backend`.
- `-p 18080:3000`: Maps host port `18080` to container port `3000`. Open `http://localhost:18080` in the browser; the backend process listens on port `3000` inside the container.
- `-v save2telegram-data:/app/data`: Persists backend data in a Docker volume, including endpoint keys and job records. Removing or recreating the container does not delete this volume.

Required backend arguments:

- `--public-url http://localhost:18080`: Public URL shown to the extension and setup page. It must match the address you use from the browser.

Optional backend arguments:

- `--app-name Save2Telegram`: Display name used by the setup page and backend logs. Defaults to `Save2Telegram`.
- `--extension-id hibaajhphchibdfkciepacbnifbeiikc`: Chrome extension ID allowed to bind to this backend. Defaults to the published Save2Telegram extension ID.
- `--secret helloworld`: Optional setup secret. If set, the setup page is available at `/?secret=helloworld`; if omitted, setup is available at `/`.
- `--host 0.0.0.0`: Backend listen host. Defaults to `0.0.0.0`.
- `--port 3000`: Backend listen port inside the container. Defaults to `3000`.
- `--telegram-api-base http://127.0.0.1:8081`: Telegram Bot API base URL used by the backend. Defaults to `https://api.telegram.org`. The same value can be set with `TELEGRAM_API_BASE`.

The backend prints the setup URL on startup:

```text
Save2Telegram setup URL: http://localhost:18080/
```

Open that URL and click the setup button to bind the backend to the extension.
If the extension is not installed yet, install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/hibaajhphchibdfkciepacbnifbeiikc) first.

## Large Video Uploads

Use the `save2telegram-backend-botserver` image for large videos. It includes the official open-source Telegram Bot API server, built from `tdlib/telegram-bot-api` during the image build. The regular `save2telegram-backend` image does not include the embedded server and uses `https://api.telegram.org` unless `TELEGRAM_API_BASE` is configured.

To upload large videos, provide your Telegram application `api_id` and `api_hash` at runtime. The botserver image will start the embedded Bot API server in `--local` mode on `127.0.0.1:8081`, then point the Save2Telegram backend at it automatically:

```bash
docker run -d --name save2telegram-backend -p 18080:3000 \
  -v save2telegram-data:/app/data \
  -v save2telegram-bot-api:/var/lib/telegram-bot-api \
  -e TELEGRAM_API_ID=123456 \
  -e TELEGRAM_API_HASH=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  ghcr.io/jerrylocke/save2telegram-backend-botserver:latest \
  --public-url http://localhost:18080
```

Get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from [my.telegram.org](https://my.telegram.org) under API development tools. These are not the same as your bot token and must not be committed to the repository.

Optional embedded Bot API environment variables:

- `TELEGRAM_BOT_API_DIR=/var/lib/telegram-bot-api`: Working directory for the embedded Bot API server. Mount it as a volume to persist its local data.
- `TELEGRAM_BOT_API_HOST=127.0.0.1`: Listen address inside the container. Keep the default unless you need to expose it.
- `TELEGRAM_BOT_API_PORT=8081`: Listen port inside the container.
- `TELEGRAM_BOT_API_ARGS="--verbosity=2"`: Extra arguments passed to `telegram-bot-api`.

To build the image locally from this repository:

```bash
docker build -t save2telegram-backend-botserver:latest -f backend/Dockerfile.local-server backend
```

`Dockerfile.local-server` uses a multi-stage build. Build dependencies stay in the builder stage; the final image only copies the compiled `telegram-bot-api` binary into the Node.js backend image.

## Restarting and Updating

Restart the existing container without deleting data:

```bash
docker restart save2telegram-backend
```

Update to a new GHCR image version and recreate the container while keeping the same data volume:

```bash
docker pull ghcr.io/jerrylocke/save2telegram-backend:latest
docker stop save2telegram-backend
docker rm save2telegram-backend
docker run -d --name save2telegram-backend -p 18080:3000 \
  -v save2telegram-data:/app/data \
  ghcr.io/jerrylocke/save2telegram-backend:latest \
  --public-url http://localhost:18080
```

Do not use `docker rm -v`, `docker volume rm save2telegram-data`, or `docker system prune --volumes` unless you intentionally want to delete the backend data.

## Backend API

- `GET /`: Setup page.
- `GET /health`: Health check.
- `POST /api/keys`: Create an endpoint key from the setup page.
- `POST /api/forward`: Forward media with Server-Sent Events progress updates.
- `POST /api/forward-jobs`: Create an async forwarding job.
- `GET /api/forward-jobs/:id`: Read job status.
- `DELETE /api/forward-jobs/:id`: Cancel a job.

Authenticated API calls use the endpoint key created during setup.

## Notes

- Video forwarding requires the extension to capture a downloadable `video.twimg.com` URL. The backend only downloads URLs passed by the extension.
- Telegram upload progress reported by the backend is the HTTP request body upload progress from the backend to Telegram. Telegram may still take a short time to process the file after upload reaches 100%.

## License

MIT. See [LICENSE](LICENSE).
