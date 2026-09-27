# Save2Telegram

[![Build](https://github.com/JerryLocke/Save2Telegram/actions/workflows/build.yml/badge.svg)](https://github.com/JerryLocke/Save2Telegram/actions/workflows/build.yml)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/hibaajhphchibdfkciepacbnifbeiikc?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/hibaajhphchibdfkciepacbnifbeiikc)
[![Latest Release](https://img.shields.io/github/v/release/JerryLocke/Save2Telegram?sort=semver)](https://github.com/JerryLocke/Save2Telegram/releases/latest)
[![GHCR](https://img.shields.io/badge/image-ghcr.io%2Fjerrylocke%2Fsave2telegram--backend-blue)](https://github.com/JerryLocke/Save2Telegram/pkgs/container/save2telegram-backend)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English README](README.md)

Save2Telegram 是一个 Chrome MV3 扩展，用于把 X/Twitter 推文和 Telegram Web K 消息里的媒体转发到 Telegram 频道。它可以完全在扩展的 service worker 中运行，也可以使用可选的 Node.js 后端处理转发。

## 项目结构

- `crx/`：Chrome 扩展源码。
- `backend/`：可选的 Node.js 转发后端，支持 Docker 部署。

## 安装扩展

从 [Chrome Web Store](https://chromewebstore.google.com/detail/hibaajhphchibdfkciepacbnifbeiikc) 安装扩展。

如需从源码加载扩展：

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

## Telegram Web 媒体转发

- 在 `https://web.telegram.org/k/` 的超级群、频道媒体消息底部、官方转发按钮右侧显示 Save2Telegram 按钮，沿用官方半透明底色和白色图标，悬停消息时显示；相册显示一个按钮，整组转发。键盘聚焦和触屏也可使用。
- 点击按钮使用最近使用的目标配置；悬停或右键打开配置菜单。消息独立加入现有队列，结果在扩展弹窗查看，不混入 X 的批量媒体草稿。
- 相册作为一条队列记录，复用 X 的叠放预览和媒体统计，例如“2 视频 1 图片”。点击转发时，从已加载的媒体预览生成小缩略图，保存在本地队列中供弹窗显示；关闭或刷新 Telegram 标签页后仍可显示，不会传给后端。没有可用预览的文件以及旧的无缩略图队列记录继续显示 TG 图标；旧记录缺少媒体类型时显示“媒体”。
- 每条记录最多保存三张缩略图，每张最长边 160px、编码不超过 48KB，无独立图片缓存。默认成功后随记录删除；开启保留已完成记录时，按设置保留最近 5／10／30 条。待处理和失败记录保留到用户删除。
- 绑定后端时，只把来源频道 ID、可用的用户名、消息 ID、复制模式提示和目标配置交给后端。普通消息调用 `TELEGRAM_API_BASE` 上的 `forwardMessages`；受保护消息调用 `copyMessages`，保留媒体、相册和说明文字，但不附带原生转发来源。不下载或重新上传媒体。未绑定后端时使用 Telegram 官方 Bot API。
- `save2telegram-backend-botserver` 的入口脚本已把 `TELEGRAM_API_BASE` 指向容器内的 Bot API Server，因此无需额外端口、文件缓存扫描或新凭据。`TELEGRAM_API_ID` / `TELEGRAM_API_HASH` 用于启动服务器，不代表已登录的个人账号，也不扩大 bot 的访问权限。
- Bot 必须能够访问来源消息并向目标发送消息。复制模式不扩大 bot 的访问权限，Telegram 不支持复制的消息类型仍会报错。私聊和普通群的消息 ID 因账号而异，不能交给 bot 复用，因此不显示按钮。Telegram Web A 暂不支持。
- 扩展和 Docker 后端需要一起更新，再重新加载扩展并刷新 Telegram 页面。旧后端会显示升级提示，避免把媒体任务误发成纯链接。

接口依据：[Telegram Bot API `forwardMessages`](https://core.telegram.org/bots/api#forwardmessages)、[`copyMessages`](https://core.telegram.org/bots/api#copymessages)。后端测试：在 `backend/` 运行 `npm test`。

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
- `--extension-id hibaajhphchibdfkciepacbnifbeiikc`：允许绑定这个后端的 Chrome 扩展 ID。默认值是已发布的 Save2Telegram 扩展 ID。
- `--secret helloworld`：可选的设置页密钥。设置后，设置页地址是 `/?secret=helloworld`；不设置时，设置页地址是 `/`。
- `--host 0.0.0.0`：后端监听地址。默认值是 `0.0.0.0`。
- `--port 3000`：容器内的后端监听端口。默认值是 `3000`。
- `--telegram-api-base http://127.0.0.1:8081`：后端使用的 Telegram Bot API 地址。默认值是 `https://api.telegram.org`。也可以用环境变量 `TELEGRAM_API_BASE` 设置。

后端启动后会在日志里输出设置地址：

```text
Save2Telegram setup URL: http://localhost:18080/
```

打开这个地址，点击设置页里的按钮，把后端绑定到扩展。
如果还没有安装扩展，请先从 [Chrome Web Store](https://chromewebstore.google.com/detail/hibaajhphchibdfkciepacbnifbeiikc) 安装。

## 大视频上传

大视频请使用 `save2telegram-backend-botserver` 镜像。它内置官方开源的 Telegram Bot API Server，并在镜像构建阶段从 `tdlib/telegram-bot-api` 编译。普通 `save2telegram-backend` 镜像不包含内置服务，除非配置 `TELEGRAM_API_BASE`，否则仍然使用 `https://api.telegram.org`。

要上传大视频，请在运行容器时提供 Telegram application 的 `api_id` 和 `api_hash`。botserver 镜像会用 `--local` 模式在 `127.0.0.1:8081` 启动内置 Bot API Server，并自动让 Save2Telegram 后端请求它：

```bash
docker run -d --name save2telegram-backend -p 18080:3000 \
  -v save2telegram-data:/app/data \
  -v save2telegram-bot-api:/var/lib/telegram-bot-api \
  -e TELEGRAM_API_ID=123456 \
  -e TELEGRAM_API_HASH=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  ghcr.io/jerrylocke/save2telegram-backend-botserver:latest \
  --public-url http://localhost:18080
```

`TELEGRAM_API_ID` 和 `TELEGRAM_API_HASH` 需要到 [my.telegram.org](https://my.telegram.org) 的 API development tools 里获取。它们不是 bot token，不能提交到代码仓库。

内置 Bot API Server 可选环境变量：

- `TELEGRAM_BOT_API_DIR=/var/lib/telegram-bot-api`：内置 Bot API Server 的工作目录。建议挂载为 volume，保留本地数据。
- `TELEGRAM_BOT_API_HOST=127.0.0.1`：容器内监听地址。除非需要暴露它，否则保持默认值。
- `TELEGRAM_BOT_API_PORT=8081`：容器内监听端口。
- `TELEGRAM_BOT_API_ARGS="--verbosity=2"`：传给 `telegram-bot-api` 的额外参数。

从本仓库本地构建镜像：

```bash
docker build -t save2telegram-backend-botserver:latest -f backend/Dockerfile.local-server backend
```

`Dockerfile.local-server` 使用 multi-stage build。编译依赖只留在 builder stage，最终镜像只把编译出的 `telegram-bot-api` 二进制复制进 Node.js 后端镜像。

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
