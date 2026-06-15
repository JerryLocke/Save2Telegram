# Save2Telegram

[![Build](https://github.com/JerryLocke/Save2Telegram/actions/workflows/build.yml/badge.svg)](https://github.com/JerryLocke/Save2Telegram/actions/workflows/build.yml)
[![Latest Release](https://img.shields.io/github/v/release/JerryLocke/Save2Telegram?sort=semver)](https://github.com/JerryLocke/Save2Telegram/releases/latest)
[![GHCR](https://img.shields.io/badge/image-ghcr.io%2Fjerrylocke%2Fsave2telegram--backend-blue)](https://github.com/JerryLocke/Save2Telegram/pkgs/container/save2telegram-backend)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English README](README.md)

Save2Telegram 是一个 Chrome MV3 扩展，用于把 X/Twitter 推文里的媒体转发到 Telegram 频道。它可以完全在扩展的 service worker 中完成下载和上传，也可以使用可选的 Node.js 后端，把媒体下载和 Telegram 上传交给独立服务处理。

## 项目结构

- `crx/`：Chrome 扩展源码。
- `backend/`：可选的 Node.js 转发后端，支持 Docker 部署。

## 安装扩展

1. 打开 `chrome://extensions/`。
2. 开启开发者模式。
3. 点击“加载已解压的扩展程序”。
4. 选择本仓库里的 `crx/` 目录。

## 配置 Telegram

1. 通过 BotFather 创建 bot，并复制 bot token。
2. 把 bot 添加为目标 Telegram 频道的管理员。
3. 打开扩展弹窗。
4. 添加 Telegram 配置，填写 bot token 和频道 ID 或公开频道 `@username`。
5. 私有频道通常需要填写 `-100` 开头的数字频道 ID。

## Docker 部署

从 GHCR 拉取并启动后端镜像：

```bash
docker pull ghcr.io/jerrylocke/save2telegram-backend:latest
docker run -d --name save2telegram-backend -p 18080:3000 \
  -v save2telegram-data:/app/data \
  ghcr.io/jerrylocke/save2telegram-backend:latest \
  --public-url http://localhost:18080
```

Docker 参数说明：

- `--name save2telegram-backend`：容器名称。之后可以用 `docker restart save2telegram-backend` 重启。
- `-p 18080:3000`：把宿主机的 `18080` 端口映射到容器内的 `3000` 端口。浏览器访问 `http://localhost:18080`，容器内服务实际监听 `3000`。
- `-v save2telegram-data:/app/data`：把后端数据保存到 Docker volume，包括端点 key 和任务记录。删除或重建容器不会删除这个 volume。

必填后端参数：

- `--public-url http://localhost:18080`：后端展示给扩展和设置页使用的公网访问地址，必须和浏览器实际访问地址一致。

可选后端参数：

- `--app-name Save2Telegram`：设置页和后端日志里显示的应用名称。默认值是 `Save2Telegram`。
- `--extension-id hgmhehcnmjfookjihllalkhdohopddnk`：允许绑定这个后端的 Chrome 扩展 ID。默认值是已发布的 Save2Telegram 扩展 ID。
- `--secret helloworld`：可选的设置页密钥。设置后，设置页地址是 `/?secret=helloworld`；不设置时，设置页地址是 `/`。
- `--host 0.0.0.0`：后端监听地址。默认值是 `0.0.0.0`。
- `--port 3000`：容器内的后端监听端口。默认值是 `3000`。

后端启动后会在日志里输出设置地址：

```text
Save2Telegram setup URL: http://localhost:18080/
```

打开这个地址，点击设置页里的按钮，把后端绑定到扩展。
如果还没有安装扩展，请先从 [Chrome Web Store](https://chromewebstore.google.com/detail/hgmhehcnmjfookjihllalkhdohopddnk) 安装。

## 重启和更新

只重启现有容器，不删除数据：

```bash
docker restart save2telegram-backend
```

更新到新的 GHCR 镜像版本，并重建容器，同时保留同一个数据卷：

```bash
docker pull ghcr.io/jerrylocke/save2telegram-backend:latest
docker stop save2telegram-backend
docker rm save2telegram-backend
docker run -d --name save2telegram-backend -p 18080:3000 \
  -v save2telegram-data:/app/data \
  ghcr.io/jerrylocke/save2telegram-backend:latest \
  --public-url http://localhost:18080
```

不要使用 `docker rm -v`、`docker volume rm save2telegram-data` 或 `docker system prune --volumes`，除非你明确想删除后端数据。

## 后端接口

- `GET /`：设置页。
- `GET /health`：健康检查。
- `POST /api/keys`：从设置页创建端点 key。
- `POST /api/forward`：转发媒体，并通过 Server-Sent Events 返回进度。
- `POST /api/forward-jobs`：创建异步转发任务。
- `GET /api/forward-jobs/:id`：读取任务状态。
- `DELETE /api/forward-jobs/:id`：取消任务。

需要认证的接口使用设置时创建的端点 key。

## 说明

- 视频转发要求扩展先捕获到可下载的 `video.twimg.com` URL。后端只下载扩展传来的 URL，不解析推文页面。
- 后端上报的 Telegram 上传进度，是后端到 Telegram API 的 HTTP request body 上传进度。上传到 100% 后，Telegram 服务器可能还需要短暂处理文件，然后才返回最终结果。

## 开源协议

MIT。见 [LICENSE](LICENSE)。
