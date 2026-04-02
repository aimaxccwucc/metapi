# 网关缓存与鉴权链路完善

## 任务信息

- 任务ID：gateway-cache-hardening-2026-04-02
- 目标：补强单机网关的鉴权缓存、响应缓存并发去重、关键配置与观测
- 范围：`src/server` 下游鉴权、响应缓存、配置、指标与测试
- 约束：单机优先；不引入新的重大依赖；不做多节点一致性改造；若涉及 Redis 只能复用现有环境，但当前默认不启用
- 完成定义：
  - 下游鉴权热路径具备缓存与 singleflight 防击穿
  - 响应缓存具备同 key 并发去重
  - 关键缓存参数可配置
  - 关键测试通过并可陈述验证结果

## 里程碑

| 里程碑 | 目标 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| M1 | 现状核对与设计定稿 | 代码核对 + 状态账本 | 已验证 |
| M2 | 鉴权缓存落地 | 单测 + 管理端失效联动验证 | 已验证 |
| M3 | 响应缓存并发去重落地 | 单测 + 代理写缓存路径核对 | 已验证 |
| M4 | 配置与观测补强 | 配置测试 + system 指标测试 | 已验证 |
| M5 | 测试验证与收尾 | 定向 Vitest + server build | 已验证 |

## 当前状态

- 已按单机内缓存方案完成下游鉴权缓存、negative cache、singleflight 防击穿与管理端失效联动。
- 已完成响应缓存同 key in-flight 去重，并将相关运行态指标接入 `/system/runtime-overview`、`/system/readyz` 与 `/system/metrics`。
- 已确认本轮不依赖 Redis，也不依赖上游缓存命中结果；缓存与并发去重均在网关进程内完成。

## 最近验证

- `npx vitest run --root . src/server/config.test.ts src/server/services/downstreamApiKeyService.test.ts src/server/services/responseCacheService.test.ts src/server/routes/system.test.ts src/server/routes/api/downstreamApiKeys.test.ts`
- `npm run build:server`

## 下一动作

- 无，等待交付说明。

