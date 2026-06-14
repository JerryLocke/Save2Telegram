# Save2Telegram

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

Build and run the backend:

```bash
cd backend
docker build -t save2telegram-backend .
docker run -d --name save2telegram-backend -p 18080:3000 \
  -e PUBLIC_URL=http://localhost:18080 \
  -e EXTENSION_ID=hgmhehcnmjfookjihllalkhdohopddnk \
  -e SECRET=helloworld \
  -v save2telegram-data:/app/data \
  save2telegram-backend
```

Command arguments:

- `--name save2telegram-backend`: Names the container. Restart it later with `docker restart save2telegram-backend`.
- `-p 18080:3000`: Maps host port `18080` to container port `3000`. Open `http://localhost:18080` in the browser; the backend process listens on port `3000` inside the container.
- `-e PUBLIC_URL=http://localhost:18080`: Public URL shown to the extension and setup page. It must match the address you use from the browser.
- `-e EXTENSION_ID=hgmhehcnmjfookjihllalkhdohopddnk`: Chrome extension ID allowed to bind to this backend.
- `-e SECRET=helloworld`: Setup secret. The setup page is available at `/?secret=helloworld`.
- `-v save2telegram-data:/app/data`: Persists backend data in a Docker volume, including endpoint keys and job records. Removing or recreating the container does not delete this volume.

The backend prints the setup URL on startup:

```text
Save2Telegram setup URL: http://localhost:18080/?secret=helloworld
```

Open that URL and click the setup button to bind the backend to the extension.

## Restarting and Updating

Restart the existing container without deleting data:

```bash
docker restart save2telegram-backend
```

Rebuild the image after code changes and recreate the container while keeping the same data volume:

```bash
cd backend
docker build -t save2telegram-backend .
docker stop save2telegram-backend
docker rm save2telegram-backend
docker run -d --name save2telegram-backend -p 18080:3000 \
  -e PUBLIC_URL=http://localhost:18080 \
  -e EXTENSION_ID=hgmhehcnmjfookjihllalkhdohopddnk \
  -e SECRET=helloworld \
  -v save2telegram-data:/app/data \
  save2telegram-backend
```

Do not use `docker rm -v`, `docker volume rm save2telegram-data`, or `docker system prune --volumes` unless you intentionally want to delete the backend data.

## GitHub Actions Build

The workflow in `.github/workflows/build.yml` builds both release artifacts:

- Chrome extension artifact: `save2telegram-extension.zip` is always uploaded. If the signing key secret is configured, `save2telegram-extension.crx` is uploaded too.
- Backend container image: pushed to `ghcr.io/<owner>/save2telegram-backend` on branch and tag builds. Pull requests build the image without pushing it.

### Extension signing

Chrome derives the extension ID from the private key used to sign the CRX, so keep using the same key for every release.

For the first release, create a private key. For later releases, reuse the existing `extension.pem`:

```bash
openssl genrsa -out extension.pem 2048
```

Store the signing key as a repository secret:

```bash
base64 -w 0 extension.pem
```

On Windows PowerShell, encode the key with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("extension.pem"))
```

Save the output in GitHub repository settings as:

- `CHROME_EXTENSION_PRIVATE_KEY_B64`: Base64-encoded PEM private key used by Chromium's `--pack-extension-key`.

Do not commit `extension.pem` to the repository. If this secret is missing, the workflow still uploads the unsigned zip for "Load unpacked" or Chrome Web Store packaging.

### Registry credentials

The default workflow publishes to GitHub Container Registry (GHCR) with `GITHUB_TOKEN`, so no extra password is required. In GitHub repository settings, ensure Actions has package write access:

- Settings -> Actions -> General -> Workflow permissions -> Read and write permissions.

If you switch to Docker Hub or another registry later, save the registry username and token/password as GitHub Actions secrets, for example `REGISTRY_USERNAME` and `REGISTRY_PASSWORD`, and pass them to `docker/login-action`. Do not hard-code registry credentials in workflow files.

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
