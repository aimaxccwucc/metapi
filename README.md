# Metapi

> 当前仓库已经明显偏离最早的“聚合站介绍页”定位。  
> 现在的 Metapi 是一个可自行部署的 AI 网关与管理后台，核心是多站点接入、协议兼容、路由选路、失败降级、站点管理与运维观测。

![Metapi](docs/logos/logo-full.png)

## 项目现状

当前代码仓库包含两部分：

- `src/server`：基于 Fastify 的服务端，负责管理 API、代理网关、协议转换、数据库初始化与后台任务。
- `src/web`：基于 React + Vite 的管理后台，负责站点、账号、令牌、路由、日志、设置和测试工具界面。

与旧版本 README 不同，当前仓库不再适合用“公开体验站”“一键零配置自动发现全部能力”这类宣传口径描述。以下内容只保留仓库中可以直接验证的现状能力。

## 当前可验证能力

### 1. 统一代理网关

服务端当前注册了这些代理入口：

- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/responses`
- `GET /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/completions`
- `GET /v1/models`
- `POST /v1/embeddings`
- `POST /v1/search`
- `POST /v1/files`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/videos`
- `GET /v1/videos/:id`
- `DELETE /v1/videos/:id`
- Gemini 兼容入口

这些入口统一挂在代理鉴权之后，默认通过 `PROXY_TOKEN` 保护。

### 2. 多协议兼容与转换

当前仓库内有独立的协议转换与归一化层，覆盖：

- OpenAI Chat Completions
- OpenAI Responses
- Anthropic Messages
- Gemini Generate Content 兼容路径

兼容内容不只包含普通文本，还包含：

- SSE 流式响应转换
- Claude / OpenAI 之间的消息格式转换
- 工具调用与工具结果
- 文件、图片、文档等输入块
- 计数接口与部分多模态路径

相关实现集中在 `src/server/transformers` 和 `src/server/routes/proxy`。

### 3. 多站点接入与平台识别

当前仓库中存在可识别或适配的平台实现，包括：

- `newApi`
- `oneApi`
- `oneHub`
- `doneHub`
- `veloera`
- `anyrouter`
- `sub2api`
- `openai`
- `claude`
- `codex`
- `gemini`
- `geminiCli`
- `antigravity`
- `cliproxyapi`

相关代码位于 `src/server/services/platforms`。

站点接入不只是保存 URL。当前后端还包含：

- 站点平台识别
- 站点协议配置
- 站点协议有限探测
- 站点健康检查
- 站点公告轮询
- 站点代理设置

注意：当前代码中的协议探测是“按模型、按候选端点有限探测”，不是枚举一个站点的全部模型。

### 4. 路由、选路与失败降级

当前项目的重点能力已经集中在路由网关。

从代码上可确认，路由层包含：

- 路由匹配与通道候选筛选
- `weighted`、`round_robin`、`stable_first` 三种路由策略
- 通道健康分计算
- 失败冷却与逐级冷却
- 模型级熔断器
- 站点运行时健康惩罚
- 选路租约，减少并发撞同一通道
- 最近失败避让
- 路由决策快照与决策明细

相关实现主要在：

- `src/server/services/tokenRouter.ts`
- `src/server/services/channelRoutingHealth.ts`
- `src/server/services/modelCircuitBreaker.ts`
- `src/server/services/proxyRetryPolicy.ts`

当前代码目标不是盲目重试，而是尽量避开刚刚失败的渠道，并把失败状态反馈进后续路由决策。

### 4.1 当前重点治理方向

当前仓库后续稳定性治理的主线已经明确收敛到两个方向：

- 路由网关：避免重复撞失败渠道，收敛协议记忆、端点回退、模型能力记忆和并发避让。
- 自动签到：重构签到状态机、失败重试与人工验证分流，避免把“尝试过”当成“已经完成”。

完整问题清单、外部对照和分阶段改造方案见：

- `docs/gateway-checkin-hardening.md`

该文档同时明确了一条硬约束：协议探测只能做“单模型有限验证”，不允许自动枚举一个站点的全部模型。

### 5. 管理后台

前端当前实际存在的主要页面包括：

- 仪表盘
- 站点管理
- 站点公告
- 账号管理
- OAuth 管理
- Token 管理
- 路由管理
- 使用日志
- 程序日志
- 监控页
- 模型广场
- 模型测试器
- 下游 Key 管理
- 导入导出
- 通知设置
- 系统设置
- 关于页面

主入口见 `src/web/App.tsx`，页面实现位于 `src/web/pages`。

当前仓库同时保留了大量页面级测试，说明前端已不是简单壳层，而是长期维护的管理系统。

### 6. 管理 API

后端除了代理接口外，还提供管理端 API，覆盖：

- 登录态与会话
- 站点管理
- 账号管理
- 账号 Token 管理
- 路由与通道配置
- 监控配置与会话
- 日志与统计
- 模型候选与市场视图
- 通知与事件
- 设置、数据库运行时切换、备份导入导出
- OAuth 提供方与回调
- 测试代理与模型测试封装接口

相关文件位于 `src/server/routes/api`。

### 7. 运维与后台任务

当前代码还包含这些持续运行能力：

- SQLite / MySQL / PostgreSQL 运行时数据库初始化
- 启动时 schema 兼容修复
- 定时签到
- 定时余额刷新
- 站点健康刷新
- 站点公告轮询
- 备份调度
- 代理日志保留清理
- 代理文件保留清理
- 默认站点种子初始化

服务启动入口见 `src/server/index.ts`。

## 不再沿用的旧表述

以下内容不再适合作为当前仓库的默认说明：

- 公开体验站地址与固定管理员令牌
- “零配置自动发现所有模型并自动最优”这类无边界承诺
- 仅以“某几个聚合站上层工具”来定义项目
- 与当前实现不对应的旧 UI 宣传语

原因很简单：当前项目已经演化成一个可持续维护的网关系统，重点在“协议兼容 + 路由稳定性 + 管理与观测”，而不是演示型介绍页。

## 技术栈

- Node.js 22+
- TypeScript
- Fastify
- React 18
- Vite
- Drizzle ORM
- SQLite / MySQL / PostgreSQL
- Vitest

依赖与脚本定义见 `package.json`。

## 目录结构

仓库主结构如下：

```text
metapi/
├── src/server        # 后端服务、代理、数据库、任务、平台适配
├── src/web           # React 管理后台
├── docs              # 文档站、截图、Logo
├── docker            # Dockerfile 与 Compose 模板
├── drizzle           # 数据库迁移
├── scripts           # 开发、升级、发布脚本
├── data              # 默认运行时数据目录
└── dist              # 构建产物
```

更详细说明可见 `docs/project-structure.md`。

## 本地开发

### 环境要求

- Node.js `>=22.15.0`
- npm

### 安装依赖

```bash
npm ci
```

### 环境变量

至少需要配置：

```bash
AUTH_TOKEN=change-me-admin-token
PROXY_TOKEN=change-me-proxy-sk-token
PORT=4000
DATA_DIR=./data
TZ=Asia/Shanghai
```

参考模板见 `.env.example`。

可选数据库配置：

- `DB_TYPE=sqlite|mysql|postgres`
- `DB_URL=...`
- `DB_SSL=true|false`

如果不显式配置，默认走 SQLite。

### 启动开发环境

```bash
npm run dev
```

可分别启动：

```bash
npm run dev:server
```

### 构建

```bash
npm run build
```

### 生产启动

```bash
npm start
```

## 测试与验证

常用命令：

```bash
npm test
npm run test:server
npm run test:web
npm run typecheck
```

数据库与 schema 相关命令：

```bash
npm run db:generate
npm run db:migrate
npm run schema:contract
npm run test:schema:unit
```

开发辅助脚本见 `scripts/dev`。

生产升级与回滚脚本见：

- `scripts/prod/upgrade.sh`
- `scripts/prod/rollback.sh`

## Docker 部署

当前仓库自带 Dockerfile 与 Compose 模板。

构建与运行逻辑见：

- `docker/Dockerfile`
- `docker/docker-compose.yml`

容器默认会在启动时先执行数据库迁移，再启动服务。

## Render 部署

仓库根目录提供了 `render.yaml`。

其中可直接确认的现状包括：

- 使用 Docker 方式部署
- 默认暴露 `PORT=4000`
- 支持通过环境变量切换到 MySQL

## 相关文档

- `docs/getting-started.md`
- `docs/deployment.md`
- `docs/configuration.md`
- `docs/upstream-integration.md`
- `docs/operations.md`
- `docs/faq.md`

## 维护说明

如果你是从旧版本项目说明进入这个仓库，建议先接受一个前提：

这个项目现在首先是“可运营的统一 AI 网关”，其次才是“聚合站上层工具”。

后续对 README 的维护建议继续遵守两个原则：

- 只写代码、脚本、路由、页面中能直接验证的能力
- 不再添加无法长期保证的体验站、演示令牌和过度营销式表述
