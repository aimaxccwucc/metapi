# 🚢 部署指南

[返回文档中心](./README.md)

---

## Zeabur 一键部署

<a href="https://zeabur.com/templates/DOX5PR">
  <img alt="Deploy on Zeabur" src="https://zeabur.com/button.svg" height="28">
</a>

点击按钮即可一键部署到 [Zeabur](https://zeabur.com)，无需手动配置 Docker 或服务器。

模板会自动完成：

- 拉取 `1467078763/metapi:latest` 镜像
- 配置 HTTP 端口（4000）
- 挂载持久化存储（`/app/data`）
- 分配域名

部署时需要填写以下变量：

| 变量 | 说明 |
|------|------|
| `AUTH_TOKEN` | 后台管理员登录令牌（请设置强密码） |
| `PROXY_TOKEN` | 下游客户端调用 `/v1/*` 时使用的 Bearer Token |
| `TZ` | 服务时区，影响定时任务和日志（如 `Asia/Shanghai`） |
| `PORT` | 内部监听端口（默认 `4000`，一般无需修改） |

部署完成后，通过 Zeabur 分配的域名访问后台管理面板即可。

---

## Docker Compose 部署（推荐）

### 标准步骤

```bash
mkdir metapi && cd metapi

# 创建 docker-compose.yml（参见快速上手）
# 设置环境变量
export AUTH_TOKEN=your-admin-token
export PROXY_TOKEN=your-proxy-sk-token

# 启动
docker compose up -d
```

### 使用 `.env` 文件

如果不想每次 export，可以创建 `.env` 文件：

```bash
# .env
AUTH_TOKEN=your-admin-token
PROXY_TOKEN=your-proxy-sk-token
TZ=Asia/Shanghai
PORT=4000
```

```bash
docker compose --env-file .env up -d
```

> ⚠️ `.env` 文件包含敏感信息，请勿提交到 Git 仓库。

## Docker 命令部署

```bash
docker run -d --name metapi \
  -p 4000:4000 \
  -e AUTH_TOKEN=your-admin-token \
  -e PROXY_TOKEN=your-proxy-sk-token \
  -e TZ=Asia/Shanghai \
  -v ./data:/app/data \
  --restart unless-stopped \
  1467078763/metapi:latest
```

> **路径说明：**
> - `./data:/app/data` — 相对路径，数据存到当前目录下的 `data` 文件夹
> - 也可以使用绝对路径：`/your/custom/path:/app/data`

## 桌面版部署（Windows / macOS / Linux）

个人电脑本地部署请直接使用 [Releases](https://github.com/cita-777/metapi/releases) 中的 Electron 安装包：

1. 下载与你系统匹配的桌面安装包
2. 安装并启动 Metapi Desktop
3. 桌面壳会自动启动本地服务并将数据保存到应用数据目录

桌面版特性：

- 内置本地 Metapi 服务，无需手动准备 Node.js 运行环境
- 托盘菜单支持重新打开窗口、重启后端、开机自启
- 支持基于 GitHub Releases 的应用内更新检查

> [!NOTE]
> 服务器部署不再提供裸 Node.js Release 压缩包，统一推荐 Docker / Docker Compose。

### 桌面版升级

1. 通过应用内更新提示安装新版本，或从 Releases 下载最新安装包覆盖安装
2. 用户数据目录会保留，升级后自动继续使用原有数据

---

## 反向代理

### Nginx

流式请求（SSE）需要关闭缓冲，否则流式输出会异常：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;

        # SSE 关键配置
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding off;

        # 标准代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时设置（长对话场景）
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

### Caddy

```
your-domain.com {
    reverse_proxy localhost:4000 {
        flush_interval -1
    }
}
```

## 升级

```bash
# 拉取最新镜像
docker compose pull

# 重新启动（数据不受影响）
docker compose up -d

# 清理旧镜像
docker image prune -f
```

## 回滚

如果升级后出现问题：

1. **升级前备份**（建议每次升级前执行）：

```bash
cp -r data/ data-backup-$(date +%Y%m%d)/
```

2. **回滚到指定版本**：

```bash
# 修改 docker-compose.yml 中的 image tag
# 例如：image: 1467078763/metapi:v1.0.0

# 恢复数据
rm -rf data/
cp -r data-backup-20260228/ data/

# 重启
docker compose up -d
```

## 数据持久化

Metapi 的所有运行数据存储在 SQLite 数据库中，位于 `DATA_DIR`（默认 `./data`）目录下。

只要挂载了该目录，升级、重启都不会丢失数据。

### 备份策略建议

- 每日自动备份 `data/` 目录
- 保留最近 7~30 天的备份
- 重要操作前手动快照

## 文档站部署

Metapi 使用 [VitePress](https://vitepress.dev) 构建文档站，支持本地预览和 GitHub Pages 自动部署。

### 本地预览

```bash
npm run docs:dev
```

访问 `http://localhost:4173` 查看文档站。

### 构建静态站点

```bash
npm run docs:build
```

构建产物位于 `docs/.vitepress/dist/`，可部署到任意静态站点托管服务。

### GitHub Pages 自动部署

推送到 `main` 分支后，`.github/workflows/docs-pages.yml` 会自动构建并部署到 GitHub Pages。

首次使用需在仓库设置中开启：

`Settings → Pages → Build and deployment → Source: GitHub Actions`

---

## 下一步

- [配置说明](./configuration.md) — 详细环境变量
- [运维手册](./operations.md) — 日志排查、健康检查
