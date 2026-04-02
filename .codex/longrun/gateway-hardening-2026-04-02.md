# 网关路由稳定性加固状态账本

## 任务ID
- gateway-hardening-2026-04-02

## 目标
- 完成无效通道分类、软禁用治理、候选准入收紧、失败预算优化、账号前置过滤、观测增强、模型能力回填。

## 范围
- `src/server/services/proxyRetryPolicy.ts`
- `src/server/services/tokenRouter.ts`
- `src/server/services/routingGovernanceService.ts`
- `src/server/services/routingGovernanceAutoRecoveryService.ts`
- 相关代理路由/预算/超时逻辑与测试

## 完成定义
- 7 项需求全部有对应实现。
- 关键测试通过，至少覆盖新增分类、治理抑制、候选准入、预算/观测、能力回填。
- 交付时能说明每项功能的生效路径与限制。

## 里程碑
1. 失败分类与治理现状梳理：已验证
2. `invalid_channel` / `upstream_group_empty` 分类与治理接入：已验证
3. 候选准入与账号前置过滤：已验证
4. 失败预算与超时策略：已验证
5. 观测增强：已验证
6. 模型能力回填与未知通道停放：已验证
7. 测试与验证：进行中

## 最近验证
- `npm test -- src/server/services/proxyRetryPolicy.test.ts` 通过
- `npm test -- src/server/routes/proxy/requestBudget.test.ts` 通过
- `npm test -- src/server/services/routingGovernanceAutoRecoveryService.test.ts` 通过
- `npm test -- src/server/services/tokenRouter.selection.test.ts` 通过
- `npm run typecheck:server` 通过

## 当前假设
- 当前实现已覆盖 7 项目标，剩余工作主要是做一轮汇总验证并确认无新的联动回归。

## 下一动作
- 跑汇总测试组合，确认长跑完成定义全部满足。

## 阻塞项
- 无
