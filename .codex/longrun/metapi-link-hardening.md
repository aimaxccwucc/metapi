## 任务ID

metapi-link-hardening

## 目标

对 `metapi` 网关链路做一轮系统加固，覆盖主动恢复探测、统一重试预算与退避、端点学习升级、流式链路收尾观测、账号级调度与诊断补强，并以可验证代码交付。

## 范围

- `src/server/services/tokenRouter.ts`
- `src/server/services/proxyRetryPolicy.ts`
- `src/server/routes/proxy/*`
- `src/server/proxy-core/*`
- `src/server/routes/api/diagnostics.ts`
- 与上述链路直接相关的测试与文档补充

## 约束

- 不处理 Windows / desktop 安装程序
- 不无关扩写 UI
- 只做链路稳定性直接相关改动

## 完成定义

1. 主动恢复探测具备实际实现，而非仅靠 TTL 被动恢复。
2. 重试具备统一预算/退避/可解释记录。
3. 端点学习从纯 block 扩展到首选恢复信号。
4. 流式链路补齐关键收尾观测与错误归因。
5. 账号级调度/诊断再增强一轮。
6. 至少完成针对性测试与构建验证，并说明未覆盖项。

## 里程碑

| 里程碑 | 目标 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| M1 | 梳理选路/重试/流式主链 | 读取核心文件与调用关系 | 已验证 |
| M2 | 主动恢复探测与治理状态回收 | 单测 + 诊断输出 | 已验证 |
| M3 | 统一重试预算与退避治理 | 单测 + 错误分类/日志验证 | 已验证 |
| M4 | 端点学习/流式观测/账号诊断增强 | 单测 + 诊断接口验证 | 已验证 |
| M5 | 构建与回归验证 | 测试 + 构建 | 已验证 |

## 当前基线

- 已有站点运行时健康、模型熔断、账号粘性、预算与租约
- 已有错误分类与部分 endpoint compatibility 学习
- 已有 `/api/routes/diagnostics` 聚合链路诊断

## 已完成实现

- `requestBudget`:
  - 增加 jitter backoff
  - 增加 `lastDelayMs`
  - 增加 `retryAfterHonoredCount`
  - 增加 `budgetExhaustedCount`
  - 增加按 `kind/status` 聚合的 retry metrics
- `system runtime-overview` / `metrics`:
  - 暴露 retry backoff 新指标
- `tokenRouter`:
  - `SiteRuntimeHealthState` 增加 `recoveryProbeAfterMs` / `lastRecoveryProbeAtMs` / `lastRecoveryProbeResult`
  - breaker 全阻断时仅放行一个 `half_open` 恢复探测候选
  - diagnostics snapshot 暴露恢复探测字段
- `upstreamEndpoint` runtime memory:
  - 增加 `preferredReason`
  - 增加 `probeAfterMs`
  - 增加 `lastProbeAtMs`
  - 增加 `lastProbeStatus`
- `upstreamProtocolProfile` persisted profile:
  - 同步增加上述恢复探测/首选原因字段
- `/api/routes/diagnostics`:
  - endpoint runtime / persisted profile 增加 `preferredReason` / `probeAfter` / `lastProbeAt` / `lastProbeStatus`
- `protocolLifecycle`:
  - 增加 transport termination summary
- `chat/responses proxyStream`:
  - 增加 `terminationReason`
  - 将 `reader_error` / `response_failed` / `empty_content` 结构化进结果
  - 通过 `[stream:<reason>] ...` 前缀写入现有 `errorMessage`
- `geminiSurface`:
  - 流式 reader throw / trailing buffer 不再误记为 success

## 最近验证

- `npx vitest run --root . src/server/routes/proxy/requestBudget.test.ts`
- `npx vitest run --root . src/server/routes/system.test.ts`
- `npx vitest run --root . src/server/services/tokenRouter.selection.test.ts`
- `npx vitest run --root . src/server/routes/api/tokens.route-diagnostics.test.ts`
- `npx vitest run --root . src/server/transformers/openai/chat/proxyStream.test.ts`
- `npx vitest run --root . src/server/transformers/openai/responses/proxyStream.test.ts`
- `npm run build`

## 未覆盖项 / 剩余风险

- `client_abort` 仍未系统接入主链；本轮先补了 upstream reader error / truncated / empty_content
- Gemini 流式分支已补 failure/success 分流，但未像 openai/responses 一样抽成统一 session 层
- 构建仍存在前端 chunk size warning，但不是本轮链路层回归或功能阻塞

## 阻塞项

无
