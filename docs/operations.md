# 🔧 运维手册

[返回文档中心](./README.md)

---

## 数据备份

### 方式一：目录备份（SQLite / Desktop，推荐）

如果当前运行的是 SQLite，最简单的备份方式是直接备份数据目录：

- Docker / 本地开发：仓库内的 `data/`
- Desktop：应用用户数据目录下的 `data/` 子目录

```bash
# 手动备份
cp -r data/ data-backup-$(date +%Y%m%d)/

# 自动备份（crontab）
0 2 * * * cp -r /path/to/metapi/data/ /path/to/backups/metapi-$(date +\%Y\%m\%d)/
```

建议：
- 每日自动备份一次
- 保留最近 7~30 天
- Desktop 备份前先退出应用
- 如果当前运行库已切到 MySQL / Postgres，不能只备份 `data/`
- 备份文件不要提交到 Git

### 方式二：数据库原生备份（MySQL / PostgreSQL）

如果当前运行库已经切到 MySQL / Postgres，请使用数据库自己的备份工具或云快照。

**MySQL 备份示例：**

```bash
# 全量导出（替换为你的实际连接信息）
mysqldump -h <HOST> -u <USER> -p<PASSWORD> metapi > metapi-backup-$(date +%Y%m%d).sql

# 自动备份（crontab，每天凌晨 3 点）
0 3 * * * mysqldump -h <HOST> -u <USER> -p<PASSWORD> metapi | gzip > /path/to/backups/metapi-$(date +\%Y\%m\%d).sql.gz
```

**PostgreSQL 备份示例：**

```bash
# 全量导出
pg_dump -h <HOST> -U <USER> -d metapi -F c -f metapi-backup-$(date +%Y%m%d).dump

# 自动备份（crontab，每天凌晨 3 点，使用 .pgpass 免交互密码）
0 3 * * * pg_dump -h <HOST> -U <USER> -d metapi -F c -f /path/to/backups/metapi-$(date +\%Y\%m\%d).dump
```

**云托管数据库：** RDS、PlanetScale、Neon 等可直接使用平台的自动快照功能。

建议：
- 升级、迁移、执行「重新初始化系统」前先做一次库级备份
- 备份对象是当前 metapi 正在使用的运行库，而不只是本地 `data/`
- 恢复后重启 Metapi 一次，确认它重新连接到了正确的运行库
- 建议保留最近 7~30 天的备份，定期清理过期文件

### 方式三：应用内导出

在管理后台 → 「导入/导出」页面：

- **全量导出**：站点、账号、Token、路由、设置
- **仅账号**：站点和账号信息
- **仅偏好**：设置和通知配置

导出为 JSON 文件，可用于跨实例迁移。

## 数据恢复

### 目录恢复（SQLite / Desktop）

服务端 SQLite 可按下面流程恢复；Desktop 则先退出应用，再替换应用用户数据目录下的 `data/` 后重新启动。

```bash
# 1. 停止容器
docker compose down

# 2. 替换数据目录
rm -rf data/
cp -r data-backup-20260228/ data/

# 3. 重新启动
docker compose up -d
```

### 应用内导入

在管理后台 → 「导入/导出」页面上传之前导出的 JSON 文件。系统会自动校验数据完整性。

### 数据库恢复（MySQL / PostgreSQL）

如果当前运行库是 MySQL / Postgres，请先用数据库自己的恢复流程把备份恢复到目标库，再重启 Metapi。若实例保存过运行库配置，重启后仍会优先连接该外部库，而不是自动回退到本地 SQLite。

## 日志排查

### Docker 环境

```bash
# 查看实时日志
docker compose logs -f

# 查看最近 100 行
docker compose logs --tail 100

# 只看错误
docker compose logs -f 2>&1 | grep -i error
```

### 本地开发

```bash
npm run dev
# 日志直接输出到终端
```

### Desktop

- 优先使用托盘菜单的 `Open Logs Folder`
- Desktop 内置后端的数据目录和日志目录都位于应用用户数据目录下

### 重点关注的日志

| 关键词 | 含义 | 处理方式 |
|--------|------|----------|
| `auth failed` | 上游站点鉴权失败 | 检查账号凭证是否过期，系统会自动尝试重登录 |
| `no available channel` | 路由无可用通道 | 检查 Token 是否同步、通道是否被冷却；可在路由页查看冷却状态 |
| `channel cooling` | 通道进入冷却期 | 通道在请求失败后自动冷却 10 分钟，期间不会被路由选中；无需干预，会自动恢复 |
| `upstream 429` | 上游限流 | 该上游站点触发了速率限制；路由引擎会自动切换其他通道，冷却期后重试 |
| `upstream 5xx` | 上游服务器错误 | 上游站点临时不可用，路由引擎会自动故障转移到其他通道 |
| `notify failed` | 通知发送失败 | 检查 [通知渠道配置](./configuration.md#通知渠道) |
| `checkin failed` | 签到失败 | 检查账号状态和站点连通性 |
| `balance refresh failed` | 余额刷新失败 | 检查账号凭证，可能需要重新登录 |
| `proxy timeout` | 代理请求超时 | 上游响应过慢；检查网络延迟或考虑切换其他通道 |
| `token expired` | Token 过期 | 系统会自动尝试续签；若反复出现，手动刷新 Token |

## 路由与签到稳定性治理

如果你遇到以下问题，不要只盯着单条报错处理：

- 路由总是先打一条失败请求，再命中正确渠道
- 某个站点已经恢复，但系统长期不再选择它
- 同一通道被并发流量重复打爆
- `interval` 签到偶发失败后，整天都不再自动补偿
- Turnstile / 人工验证被统计成“签到成功”

这类问题通常不是单点配置错误，而是稳定性模型本身需要调整。请优先阅读：

- [路由与签到稳定性改造](./gateway-checkin-hardening.md)

当前运维侧应遵守以下原则：

- 协议探测只做单模型有限验证，不做全站模型扫描。
- `manual verification` 视为人工待办，不视为签到成功。
- 看到模型或端点长期不可用时，优先检查“失败记忆是否缺少恢复路径”，而不是一味提高重试次数。
- 对流式长请求，优先检查并发占用和租约是否失真，而不是只看冷却时间。

### 路由稳定性诊断（TokenRoutes）

推荐把 TokenRoutes 页面的“路由稳定性诊断”作为第一排障入口。该视图会一次性聚合：

- 端点运行时记忆与持久协议画像
- 模型熔断状态与站点运行时健康
- 持久不可用模型阻断
- 站点协议配置摘要
- 签到待办（含 manual required / unsupported / failed recent）

建议排障顺序：

1. 先看顶部高亮指标（端点阻断、模型熔断、站点熔断、不可用阻断、签到待处理）。
2. 若“模型熔断中”或“站点熔断中”偏高，优先处理对应明细中的高频失败站点/模型。
3. 若“持久不可用阻断”偏高，检查是否仍在 TTL 窗口，必要时走定向复验而非全量重试。
4. 若“签到待处理”偏高，先区分人工验证与可重试失败，不要把 `manual verification` 当作成功。

补充说明：

- 从当前版本开始，选路阶段“无可用通道”的请求也会写入使用日志，第三方调用不再因前置选路失败而漏展示。

## 健康检查

### 手动检查

```bash
# 检查服务是否响应
curl -sS http://localhost:4000/v1/models \
  -H "Authorization: Bearer <PROXY_TOKEN>" | head -5

# 检查特定模型可用性
curl -sS http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'
```

以上示例默认服务端部署监听 `localhost:4000`。如果你把服务暴露到局域网或公网，请改用对应的实际地址并结合反向代理、访问控制和令牌策略一起检查。

### 自动化监控建议

- 定时请求 `/v1/models`，检查返回状态码和模型数量
- 定时抽样请求 `/v1/chat/completions`，检查端到端可用性
- SQLite：监控磁盘空间（SQLite WAL 日志可能增长）
- MySQL / Postgres：监控外部数据库空间、连接数和慢查询
- 监控 Docker 容器状态

## 常见运维操作

### 清理代理日志

代理日志会持续增长。如果磁盘空间紧张，可在管理后台 → 代理日志页面清理历史记录。

### 重置账号状态

如果账号状态异常（`unhealthy`），可以在账号管理页面：

1. 点击「刷新」重新检测账号健康状态
2. 如凭证过期，系统会尝试自动重登录
3. 手动禁用/启用账号

### 强制刷新模型

在管理后台手动触发：

- 余额刷新：立即更新所有账号余额
- 模型刷新：重新发现所有上游模型
- 签到：立即执行一次签到

### 系统代理

在管理后台「设置 → 系统代理」中保存全局代理地址后，只有启用了「使用系统代理」的站点才会走这条出站代理。

- 单个站点可在站点页直接开关
- 站点页支持批量开启 / 关闭系统代理
- 修改系统代理地址后，Metapi 会自动失效站点代理缓存，通常无需手工重启

### 清理缓存并重建路由

当模型列表（`GET /v1/models`）、路由列表或选择概率明显滞后时，使用以下操作：

| 操作 | 位置 | 适用场景 |
|------|------|----------|
| **清除缓存并重建路由** | 设置 → 清除缓存并重建路由 | 全局刷新：清空模型发现缓存、自动路由和自动通道，后台触发模型刷新与路由重建 |
| **重建路由** | TokenRoutes → 重建路由 | 局部刷新：调整账号、Token、路由规则后手动重新生成自动路由 |

优先使用「重建路由」做局部刷新，问题持续时再用全局清除。

### 批量操作

管理后台支持以下批量运维动作：

- 站点：批量启用、禁用、删除、开启系统代理、关闭系统代理
- 账号：批量刷新余额、启用、禁用、删除
- Token：批量启用、禁用、删除

批量操作完成后，界面会返回成功/失败数量；删除站点或账号后，路由相关缓存会自动失效。

### 重新初始化系统

这是高风险操作，位于「设置 → 危险操作」。

- 会清空当前 metapi 正在使用的全部业务数据
- 如果当前运行在外部 MySQL / Postgres，会先清空该外部库中的 metapi 数据，再切回默认 SQLite
- 当前管理员令牌与代理令牌会保留
- 当前登录会话会立即退出，页面刷新后回到首装状态

执行前建议先做一次导出或数据库备份。

## 下一步

- [常见问题](./faq.md) — 常见报错与修复
- [配置说明](./configuration.md) — 环境变量详解
- [上游接入](./upstream-integration.md) — 平台特定的连接与排障
- [客户端接入](./client-integration.md) — 下游客户端对接
