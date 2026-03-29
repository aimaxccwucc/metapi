# Failure Routing Hardening

## Spec

- 任务ID：failure-routing-hardening-2026-03-28
- 目标：排查并修复失败站点或失败模型仍被持续调用的问题，覆盖主要代理入口、选路逻辑和失败熔断路径。
- 范围：`src/server/services/tokenRouter.ts`、`src/server/proxy-core/surfaces/*`、`src/server/routes/proxy/*`、相关测试、提交与正式环境部署。
- 约束：最小改动、不扩大无关重构、不新增重大依赖；先验证后部署。
- 完成定义：
  - 主要代理入口在“全部候选近期失败”场景下快速失败，不再继续恢复探测。
  - 报错站点对应模型不会在失败窗口内被重复命中。
  - 若当前模型存在最近成功且仍可用的站点，则优先复用该站点；只有当这批站点全部不可用时，才重新尝试其他站点。
  - 默认新建精确路由采用更稳妥的 `stable_first`。
  - Gemini 网关不再对明确不可恢复的错误继续跨站重试。
  - 相关测试通过，代码已提交，正式环境已更新并完成基本复核。

## Plan

1. 恢复当前状态，确认已有改动与未完成验证。
2. 系统排查所有代理入口与失败熔断路径，确认剩余同类问题。
3. 实现必要修复并补回归测试。
4. 运行最相关测试与必要构建验证。
5. 提交代码并部署正式环境。
6. 线上复核并记录结果。

## Status

- 当前阶段：提交与部署前复核
- 里程碑状态：
  - M1 状态恢复：已验证
  - M2 全链路排查：已验证
  - M3 修复与测试：已验证
  - M4 提交与部署：进行中
  - M5 线上复核：未开始
- 已完成：
  - 已修复 `tokenRouter` 中“全部候选近期失败后继续保守恢复探测”的路径。
  - 已修复“模型不支持时同站点兄弟通道仍可继续命中同一模型”的问题。
  - 已新增“最近成功站点优先复用”规则，信号直接取自入库的 `route_channels.last_used_at` / `success_count`，不依赖进程内内存态，重启后仍生效。
  - 已将自动创建的新精确路由默认策略切换为 `stable_first`。
  - 已为 Gemini surface 增加“仅明确不可恢复错误终止 failover”的门控。
  - 已确认主要 surface 的单次请求内兼容回退不构成跨请求持续命中问题。
- 最近修复：
  - `weighted` / `stable_first` 在通过熔断、近期失败、账号预算、并发租约过滤后，若仍存在最近成功站点，则仅在这些站点内继续选路。
  - 只有当当前模型对应的最近成功站点全部不可用时，才会重新尝试其他站点。
  - 已补充“最近成功站点优先复用”和“清空运行时内存后仍可复用”回归测试。
  - 自动建路由默认写入 `routing_strategy='stable_first'`，避免新路由默认落到偏探索的 `weighted`。
  - Gemini surface 对 `unsupported model`、本地缺项目配置等明确不可恢复错误直接终止，对可恢复的 400/403/网络错误保留原有 failover。
- 最近验证：
  - `npm test -- src/server/services/tokenRouter.selection.test.ts`
  - `npm test -- src/server/services/tokenRouter*.test.ts`
  - `npm test -- src/server/routes/proxy/chat.stream.test.ts src/server/routes/proxy/search.test.ts src/server/routes/proxy/images.media-routing.test.ts src/server/routes/proxy/gemini.test.ts`
  - `npm test -- src/server/routes/proxy/gemini.test.ts src/server/services/modelService.test.ts src/server/services/proxyRetryPolicy.test.ts src/server/db/routeGroupingSchemaCompatibility.test.ts src/server/db/schemaContract.test.ts`
  - `npm run build:server`
  - 结果：全部通过
- 下一动作：
  - 提交当前修复。
  - 执行正式部署脚本。
  - 使用线上服务与 MySQL 日志复核“最近成功站点优先复用”。
- 阻塞项：无
