# 🚀 快速上手

本文档帮助你在 10 分钟内完成 Metapi 的首次部署。

[返回文档中心](./README.md)

---

## 前置条件

- Docker 与 Docker Compose（推荐）
- 或下载 [Release 包](https://github.com/cita-777/metapi/releases) + Node.js 20+（免 Docker 运行）
- 或 Node.js 20+ 与 npm（本地开发）

## 方式一：Docker Compose 部署（推荐）

### 1. 创建项目目录

```bash
mkdir metapi && cd metapi
```

### 2. 创建 `docker-compose.yml`

```yaml
services:
  metapi:
    image: 1467078763/metapi:latest
    ports:
      - "4000:4000"
    volumes:
      - ./data:/app/data
    environment:
      AUTH_TOKEN: ${AUTH_TOKEN:?AUTH_TOKEN is required}
      PROXY_TOKEN: ${PROXY_TOKEN:?PROXY_TOKEN is required}
      CHECKIN_CRON: "0 8 * * *"
      BALANCE_REFRESH_CRON: "0 * * * *"
      PORT: ${PORT:-4000}
      DATA_DIR: /app/data
      TZ: ${TZ:-Asia/Shanghai}
    restart: unless-stopped
```

### 3. 设置令牌并启动

```bash
# AUTH_TOKEN = 管理后台初始管理员令牌（登录后台时输入这个值）
export AUTH_TOKEN=your-admin-token
# PROXY_TOKEN = 下游客户端调用 /v1/* 使用的令牌
export PROXY_TOKEN=your-proxy-sk-token
docker compose up -d
```

### 4. 访问管理后台

打开 `http://localhost:4000`，使用 `AUTH_TOKEN` 的值登录。

> [!TIP]
> 初始管理员令牌就是启动时配置的 `AUTH_TOKEN`。  
> 如果未显式设置（非 Compose 场景），默认值为 `change-me-admin-token`（仅建议本地调试）。  
> 若你在后台「设置」里修改过管理员令牌，后续登录请使用新令牌。

## 方式二：桌面版启动（Windows / macOS / Linux）

如果你是在个人电脑上本地使用，请直接下载桌面版安装包：

1. 打开 [Releases](https://github.com/cita-777/metapi/releases) 下载与你系统匹配的桌面安装包
2. 安装并启动 Metapi Desktop
3. 桌面壳会自动启动本地服务并保存数据，无需手动准备 Node.js 环境

> [!NOTE]
> 服务器部署统一推荐 Docker / Docker Compose，不再提供裸 Node.js 的 Release 压缩包。

## 方式三：本地开发启动

```bash
git clone https://github.com/cita-777/metapi.git
cd metapi
npm install
npm run db:migrate
npm run dev
```

- 前端地址：`http://localhost:5173`（Vite dev server）
- 后端地址：`http://localhost:4000`

## 首次使用流程

完成部署后，按以下顺序配置：

> [!TIP] 从 ALL-API-Hub 迁移（可选）
> 如果你使用过 ALL-API-Hub，Metapi 兼容其导出的备份设置，可直接导入，无需手动逐项配置。
>
> ![ALL-API-Hub备份导入](./screenshots/allapi-hub-backup.png)

### 步骤 1：添加站点

进入 **站点管理**，添加你使用的上游中转站：

- 填写站点名称（自己想怎么取就怎么取）和 URL
- 选择平台类型（New API / One API / OneHub / DoneHub / Veloera / AnyRouter / Sub2API），通常可自动检测
- 填写站点的管理员 API Key（可选，部分功能需要）

![站点管理](./screenshots/site-management.png)

### 步骤 2：添加账号

首先前往你想添加的公益站，进入下图界面：

![账号管理](./screenshots/account-management.png)

进入 **账号管理**，为每个站点添加已注册的账号：



![账号余额](./screenshots/account-balance.png)

- 填入用户名和访问凭证

  ![账号凭证](./screenshots/account-credentials.png)

- 系统会自动登录并获取余额信息

![账号余额](./screenshots/account-balance.png)

- 启用自动签到（如站点支持）

### 步骤 3：同步 Token

进入 **Token 管理**：

- 点击「同步」从上游账号拉取 API Key

- 或手动添加已有的 API Key，如下图所示。

  ![Token管理](./screenshots/token-management.png)

### 步骤 4：检查路由

进入 **路由管理**：

- 系统会自动发现模型并生成路由规则
- 可以手动调整通道的优先级和权重

### 步骤 5：验证代理

使用 curl 快速验证：

```bash
# 检查模型列表
curl -sS http://localhost:4000/v1/models \
  -H "Authorization: Bearer your-proxy-sk-token"

# 测试对话
curl -sS http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-sk-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

返回正常响应，说明一切就绪。

## 下一步

- [部署指南](./deployment.md) — 反向代理、HTTPS、升级策略
- [配置说明](./configuration.md) — 详细环境变量与路由参数
- [客户端接入](./client-integration.md) — 对接 Open WebUI、Cherry Studio 等
