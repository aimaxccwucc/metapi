# 路由治理与路由页性能治理

本文档沉淀 2026-04 这轮“路由治理 + 路由页减载”的正式设计与实施边界，目标是把现有网关从“局部有能力但链路分散”收敛到“可解释、可恢复、可运营”的统一体系。

[返回文档中心](./README.md)

---

## 目标

- 把不可用通道的系统隔离从零散运行时逻辑，收敛成统一的持久治理状态。
- 把失败后的恢复从“只能等下一次随机流量撞上去”，收敛成受控的恢复窗口与探测态。
- 把 `tokenRouter` 的候选过滤、失败写回、恢复解封统一到同一套状态模型。
- 把路由页首屏从“自动拉重型诊断 + 候选索引 + 大量卡片”改成“轻量概览先到，重诊断按需加载”。

## 非目标

- 不做新的全局路由算法重写。
- 不做 Redis、队列或新的基础设施引入。
- 不做无边界的全站/全模型后台探测。
- 不把系统隔离直接写回 `route_channels.enabled`。

## 已审计现状

### 已有能力

- `tokenRouter` 已有冷却、模型熔断、站点运行时惩罚、账号速率预算、粘性会话和持久不可用模型。
- 失败分类已经统一走 `proxyRetryPolicy`，并且 `Retry-After` 已能反馈到请求退避和账号预算避让。
- 路由页已有决策快照、来源模型检测、按需加载通道、渐进渲染等基础能力。

### 关键缺口

- “系统隔离”还没有独立持久层，站点/账号/token/channel 的失效状态散落在多个 runtime map 和表里。
- 现有持久不可用模型只覆盖 token/account + model，不覆盖 site/channel/balance/auth/quota 等治理场景。
- 路由页首屏仍会自动加载 `/api/routes/diagnostics`，并在显式群组存在时提前拉全量 `model token candidates`。
- `/api/routes/summary` 为了算 `channelCount/siteNames` 仍会间接扫大量通道数据。

## 设计原则

### 1. 手工禁用和系统隔离分层

- 手工禁用继续用 `enabled`。
- 系统隔离一律落独立治理状态表，不修改运营显式配置。

### 2. 资格判断优先于失败后重试

- 能在候选过滤阶段排除的站点/账号/token/channel，不应再依赖真正打上游失败后才能规避。

### 3. 恢复必须受控

- 系统隔离不能永久锁死。
- 解除隔离只能通过成功回写、外部恢复链路成功、治理恢复轮转，或人工清理。

### 4. 首屏只拉轻量数据

- 首屏只拿路由摘要和治理概览。
- 深度诊断、通道明细、来源候选、重型明细都改为显式按需加载。

## 数据模型

新增表：`routing_governance_states`

用途：

- 统一表达 `site/account/token/channel` 四类 subject 的系统治理状态。
- 支持全局隔离和按模型隔离两种作用域。
- 当前只持久化 `suppressed / probing` 两种活跃状态；恢复后直接删除记录。

核心字段：

- `subject_type`: `site | account | token | channel`
- `subject_id`: 对应 subject 主键
- `model_name`: 为空字符串表示全局；非空表示仅对该模型隔离
- `state`: `suppressed | probing`
- `reason_code`: `auth | rate_limit | balance_exhausted | quota_exhausted | model_unsupported | manual_recheck_needed`
- `reason_detail`
- `probe_model_name`
- `last_http_status`
- `failure_count`
- `success_count`
- `suppress_until`
- `probe_after`
- `last_failure_at`
- `last_success_at`
- `last_probe_at`
- `last_probe_status`
- `last_probe_message`
- `created_at`
- `updated_at`

关键索引：

- 唯一键：`(subject_type, subject_id, model_name)`
- 查询键：`(state, suppress_until, probe_after)`
- 主体查询：`(subject_type, subject_id)`
- 原因查询：`(reason_code, state)`

## 状态机

### `suppressed`

- 候选被系统隔离
- `tokenRouter` 直接过滤，不进入可选池
- 必须记录原因、作用域和恢复时间

### `probing`

- 已进入恢复窗口
- 允许重新进入候选池
- 在候选解释中展示“系统复测中”
- 成功后删除治理记录
- 再次失败则重新进入 `suppressed`

## 失败到治理动作映射

### 认证失败

- 条件：`401/403` 或明确 `invalid api key / token expired`
- 治理动作：
  - token 级全局隔离优先
  - 无 token 时降级为 account 级全局隔离
  - 较长 `suppress_until`

### 限流 / 配额

- 条件：`429` 或明确 `quota exceeded / rate limit`
- 治理动作：
  - token 级全局隔离优先；无 token 时降级为 account 级全局隔离
  - `suppress_until` 直接取 `Retry-After` 或保守冷却窗口

### 模型不支持

- 条件：`model_unsupported`
- 治理动作：
  - token/account 级按模型隔离
  - 必要时补 channel 级按模型隔离，避免同源通道重复命中

### 余额耗尽

- 条件：余额刷新结果明确为 `balance <= 0` 或 `quota <= 0`
- 治理动作：
  - account 级全局隔离
  - 由余额刷新成功自动解除

### 一般临时失败

- 条件：`server / network`
- 治理动作：
  - 仍以现有运行时冷却、站点惩罚、模型熔断为主
  - 不默认写长期治理状态，避免误杀

## 候选过滤接入点

统一接入 `tokenRouter.getCandidateEligibilityReasons`

过滤顺序：

1. 手工禁用与原有基础资格
2. 持久不可用模型
3. 系统治理状态
4. 运行时冷却 / 熔断 / 站点惩罚

表现方式：

- `suppressed`：直接追加不可用原因并阻断候选
- `probing`：不阻断，但在解释里显示“系统复测中”

## 恢复与解封

### 被动恢复

- 请求成功后清理对应 subject 的治理状态
- 余额刷新成功后清理 account 级余额/认证类治理状态
- token 同步成功后清理 token 级认证类治理状态

### 主动恢复轮转

定时任务当前只做一件事：

1. 把已到 `suppress_until / probe_after` 的记录从 `suppressed` 转成 `probing`

约束：

- 不做无界后台扫站点
- 不主动探测所有模型
- 恢复窗口只把 subject 放回“可试但受观察”的状态
- `probing` 采用受控放量，不做后台真实上游探测

## API 改造

### 新增

- `GET /api/routes/overview`
  - 轻量治理概览
  - 返回路由/通道数、系统隔离数、复测态数、模型熔断数、站点惩罚数等

- `GET /api/routes/governance/subjects`
  - 返回当前 `suppressed / probing` 记录
  - 用于路由页治理面板

- `POST /api/routes/governance/recovery-pass`
  - 触发一次恢复轮转
  - 返回扫描数量与转入 `probing` 数量

### 现有接口改造

- `GET /api/routes/summary`
  - 改成轻量聚合实现，不再扫全量通道明细

- `GET /api/routes/diagnostics`
  - 保留为重型深诊断接口
  - 不再首屏自动加载

## 前端改造

### 首屏策略

- 首屏只加载：
  - `getRoutesSummary`
  - `getRouteOverview`

- 首屏不自动加载：
  - `getRouteDiagnostics`
  - `getModelTokenCandidates`

### 路由页 UI

- 保留现有路由卡片、按需加载通道、决策快照
- 新增“系统隔离”治理概览 badge
- 新增“系统隔离列表 / 复测中列表”
- 新增“执行恢复轮转”按钮
- 深度诊断改为显式展开后再加载

## MySQL 设计注意点

- `model_name / state / subject_type` 在 generated artifacts 中会被收敛为可索引短字符串
- 对可能参与索引的文本字段避免无界长文本；详细错误继续落 `reason_detail`
- 兼容仓库生成产物时，遵守现有 generated artifact 链路，不再手写 MySQL 专属临时 DDL

## 验证计划

- schema 合约与 generated 产物测试
- `tokenRouter` 选择/失败/恢复测试
- 路由 API 测试
- 路由页前端测试
- `build:server`

## 风险与回滚

主要风险：

- 治理规则过严导致误杀可用通道
- 路由页类型或接口形态变更带来前端测试回归

回滚方式：

- 治理表与服务为增量引入，可通过停用治理过滤逻辑快速回退
- 路由页重型诊断接口仍保留，不会阻断旧的排障能力
