# 自动最低倍率分组 Key 全自动化

## 任务
- 标题：自动最低倍率分组 Key 全自动闭环
- 目标：实现历史/新增站点、账号、路由、模型刷新后，自动补齐最低倍率分组 Key 覆盖；统一逻辑、失败冷却、状态可观测、后台收敛、测试、提交、上线
- 范围：`src/server` 主；必要 `src/web` 提示；测试；部署脚本/上线
- 完成定义：
  - 1. 新建精确路由自动补最低倍率组 Key
  - 2. 新建账号/站点后自动扫描并补历史精确路由缺口
  - 3. token 新增/同步后自动扫描并补缺口
  - 4. 全量刷新模型并重建路由后自动后台收敛历史缺口
  - 5. 统一最低倍率组选择与自动建 Key 逻辑，消灭重复实现
  - 6. 失败冷却/状态记录/可观测
  - 7. 相关测试通过，代码提交，线上更新

## 里程碑
- M1：现状梳理与统一服务设计
- M2：统一自动补 Key 服务落地
- M3：接入路由创建、账号初始化、token 覆盖刷新、全量刷新
- M4：状态记录、冷却、后台任务/收敛
- M5：前端提示与回显校正
- M6：测试补齐与修复
- M7：提交与上线

## 当前状态
- 当前阶段：M6-M7
- 最近验证：
  - `pnpm -s vitest run src/server/routes/proxy/requestBudget.test.ts src/server/routes/api/tasks.test.ts src/server/services/modelService.discovery.test.ts src/server/routes/api/tokens.autocreate-coverage.test.ts src/server/routes/api/accountTokens.coverage-refresh.test.ts src/server/routes/api/accountTokens.coverage-refresh-failure.test.ts src/server/routes/api/accounts.add-background-task.test.ts src/server/routes/api/stats.marketplace.test.ts src/web/pages/tokenRoutes.group-collapse.test.tsx` 通过
- 下一动作：提交代码，执行生产升级，验证公网 `/accounts` 与长流超时配置表现
- 阻塞：无

## 决策记录
- 采用长跑模式
- 先统一服务，再接入口；不在每个入口复制逻辑
- 已新增 `token_coverage_autoprovision_states` 状态表与兼容层
- 已新增 `tokenCoverageAutoProvisionService`
- 已把账号初始化、token 覆盖刷新、OAuth、全量刷新、路由创建接到统一服务
- 已补 `/api/tasks` 对 auto provision summary 富化，任务中心可直接看创建/复用/冷却/失败计数
- 已修流式代理超时语义：
  - 总预算继续用于选路/重试/首字节前
  - 流开始后不再被单次请求硬超时切断
  - 流式改走 `firstByteTimeoutMs + idle timeout`
- 线上部署目录与当前容器环境未发现显式 `UPSTREAM_*` 配置；2 分钟断流更可能来自旧代码路径或外层代理限制，先以上述修复上线验证
