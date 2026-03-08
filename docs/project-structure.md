# Metapi 项目目录规范

本文档说明 Metapi 的目录组织方式，目标是让新功能落位更稳定、查找更直接、临时文件不污染根目录。

## 顶层目录

```text
metapi/
├── data/                  # 运行时数据（SQLite 数据库）
├── dist/                  # 构建产物（前后端）
├── docker/                # 容器相关文件
│   ├── Dockerfile         # 多阶段构建（Alpine）
│   ├── docker-compose.yml # Docker Compose 编排
│   └── docker-compose.override.yml # 开发覆盖配置
├── docs/                  # 文档与资源
│   ├── .vitepress/        # VitePress 文档站配置
│   ├── community/         # 社区贡献规范
│   ├── logos/             # Logo 素材
│   │   └── drafts/        # Logo 草稿
│   ├── screenshots/       # 界面截图
│   └── *.md               # 各文档页面
├── drizzle/               # Drizzle ORM 迁移 SQL 与元数据
├── scripts/               # 项目脚本（按场景分组）
│   ├── dev/
│   │   └── restart.bat    # Windows 开发环境快捷重启
│   └── desktop/
│       └── afterSign.mjs  # Electron macOS 签名后处理 / 可选公证
├── src/
│   ├── desktop/           # Electron 主进程与桌面运行时
│   ├── server/            # Fastify 后端服务
│   └── web/               # React 前端应用
├── .github/workflows/     # CI/CD 工作流
│   ├── ci.yml             # 测试与构建检查
│   ├── release.yml        # 多平台 Release 包发布
│   └── docs-pages.yml     # 文档站 GitHub Pages 部署
├── tmp/                   # 临时调试文件（已 gitignore）
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
├── drizzle.config.ts
└── README.md
```

## 后端目录约定（`src/server`）

```text
src/server/
├── index.ts               # 服务启动入口
├── config.ts              # 环境变量与配置加载
├── middleware/
│   └── auth.ts            # 认证中间件
├── db/
│   ├── index.ts           # 数据库连接
│   ├── schema.ts          # Drizzle 表定义（全部 Schema）
│   └── migrate.ts         # 迁移执行器
├── routes/
│   ├── api/               # 管理 API 路由
│   │   ├── auth.ts        # 登录 / 登出
│   │   ├── sites.ts       # 站点 CRUD
│   │   ├── accounts.ts    # 账号管理
│   │   ├── accountTokens.ts # Token 同步与管理
│   │   ├── tokens.ts      # Token 批量操作与路由规则管理
│   │   ├── downstreamApiKeys.ts # 下游 API Key 管理
│   │   ├── checkin.ts     # 签到触发与日志
│   │   ├── stats.ts       # 仪表盘统计
│   │   ├── search.ts      # 全局搜索
│   │   ├── events.ts      # 事件日志
│   │   ├── tasks.ts       # 后台任务状态
│   │   ├── settings.ts    # 运行时配置
│   │   ├── monitor.ts     # 外部监控集成
│   │   └── test.ts        # 测试 / 验证端点
│   └── proxy/             # 代理路由
│       ├── router.ts      # 代理路由注册
│       ├── chat.ts        # Chat Completions & Claude Messages
│       ├── responses.ts   # OpenAI Responses 端点
│       ├── completions.ts # Legacy Completions
│       ├── embeddings.ts  # 向量嵌入
│       ├── images.ts      # 图像生成
│       ├── models.ts      # 模型列表
│       ├── chatFormats.ts # OpenAI <-> Claude 格式转换
│       ├── upstreamEndpoint.ts  # 上游端点处理与透传
│       └── downstreamPolicy.ts  # 下游 API Key 策略校验
└── services/
    ├── platforms/          # 平台适配器
    │   ├── base.ts         # 适配器接口定义
    │   ├── index.ts        # 适配器注册表
    │   ├── newApi.ts       # New API 适配器
    │   ├── oneApi.ts       # One API 适配器
    │   ├── oneHub.ts       # OneHub 适配器
    │   ├── doneHub.ts      # DoneHub 适配器
    │   ├── veloera.ts      # Veloera 适配器
    │   ├── anyrouter.ts    # AnyRouter 适配器
    │   └── sub2api.ts      # Sub2API 适配器
    ├── tokenRouter.ts              # 智能路由引擎
    ├── checkinService.ts           # 签到执行
    ├── checkinScheduler.ts         # 签到调度
    ├── checkinRewardParser.ts      # 奖励金额解析
    ├── balanceService.ts           # 余额刷新
    ├── modelService.ts             # 模型发现与管理
    ├── modelPricingService.ts      # 模型定价
    ├── modelAnalysisService.ts     # 使用分析
    ├── notifyService.ts            # 多渠道通知
    ├── notificationThrottle.ts     # 通知节流
    ├── alertService.ts             # 告警事件
    ├── alertRules.ts               # 告警规则
    ├── backupService.ts            # 数据导入导出
    ├── backgroundTaskService.ts    # 后台任务管理
    ├── accountCredentialService.ts # 凭证加密
    ├── accountHealthService.ts     # 健康状态管理
    ├── accountExtraConfig.ts       # 平台专属配置
    ├── accountTokenService.ts      # Token 管理服务
    ├── downstreamApiKeyService.ts  # 下游 API Key 服务
    ├── downstreamPolicyTypes.ts    # 下游策略类型定义
    ├── proxyRetryPolicy.ts         # 重试策略
    ├── proxyUsageParser.ts         # Token 用量解析
    ├── proxyUsageFallbackService.ts # 余额兜底估算
    ├── failureReasonService.ts     # 错误分类
    ├── siteDetector.ts             # 平台自动检测
    ├── dailySummaryService.ts      # 每日摘要
    ├── todayIncomeRewardService.ts # 今日收入快照
    ├── localTimeService.ts         # 时区处理
    ├── upstreamModelDescriptionService.ts # 上游模型描述缓存
    ├── startupInfo.ts              # 启动信息
    └── settings.ts                 # 运行时配置管理
```

## 前端目录约定（`src/web`）

```text
src/web/
├── App.tsx                # 应用入口与路由配置
├── main.tsx               # Vite 入口
├── api.ts                 # 统一 API 请求客户端
├── authSession.ts         # 认证会话管理
├── i18n.tsx               # 国际化
├── i18n.supplement.ts     # 国际化补充翻译
├── components/            # 通用 UI 组件
│   ├── BrandIcon.tsx      # 模型品牌图标
│   ├── ChangeKeyModal.tsx # 修改管理令牌弹窗
│   ├── ModelAnalysisPanel.tsx # 消费分析图表
│   ├── ModernSelect.tsx   # 自定义下拉选择组件
│   ├── SearchModal.tsx    # 全局搜索弹窗
│   ├── NotificationPanel.tsx # 实时事件面板
│   ├── Toast.tsx          # 通知提示
│   └── charts/            # 图表组件
│       ├── SiteDistributionChart.tsx # 余额分布饼图
│       └── SiteTrendChart.tsx       # 消费趋势图
├── pages/                 # 页面组件（路由页）
│   ├── Dashboard.tsx      # 仪表盘
│   ├── Sites.tsx          # 站点管理
│   ├── Accounts.tsx       # 账号管理
│   ├── Tokens.tsx         # Token 管理
│   ├── TokenRoutes.tsx    # 路由规则
│   ├── Models.tsx         # 模型广场
│   ├── ModelTester.tsx    # 模型操练场
│   ├── Monitors.tsx       # 可用性监控
│   ├── CheckinLog.tsx     # 签到日志
│   ├── ProxyLogs.tsx      # 代理日志
│   ├── ProgramLogs.tsx    # 系统事件日志
│   ├── ImportExport.tsx   # 数据导入导出
│   ├── Settings.tsx       # 系统设置
│   ├── NotificationSettings.tsx # 通知设置
│   ├── About.tsx          # 关于页面
│   └── helpers/           # 页面级纯逻辑 / 工具函数（含测试）
└── public/                # 静态资源
```

## 目录卫生规则

- 所有调试临时文件放入 `tmp/`，不要散落在项目根目录。
- 开发脚本统一放入 `scripts/<scene>/`，根目录仅保留必要入口文件。
- 素材草稿统一归档到 `docs/logos/drafts/`，避免根目录堆积二进制文件。
- 测试文件与被测文件同目录（`*.test.ts`），方便就近维护。
- 平台适配器新增时，在 `services/platforms/` 中创建独立文件并注册到 `index.ts`。
