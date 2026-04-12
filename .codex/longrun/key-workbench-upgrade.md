## 任务

- 标题：接入诊断工作台、模型测速与定向导出落地
- 目标：把“单凭证诊断闭环”“模型测速与默认模型推荐”“面向客户端的定向导出”落实到 Metapi 代码，并尽量接入现有路由排障链
- 当前日期：2026-04-03

## 完成定义

- 诊断页与诊断接口可用，支持站点 / 账号 / 令牌三类对象
- 模型轻量测速与推荐逻辑可用
- 下游密钥定向导出可用
- 路由治理 / 通道探测 / 稳定性诊断可直接跳到诊断工作台并自动带上下文
- `typecheck`、定向测试、`build` 通过

## 里程碑

1. 现状核对与文档落点
   - 状态：已验证
   - 验证：已新增 `docs/key-workbench-upgrade.md`，并挂到 VitePress 导航
2. 单凭证诊断闭环
   - 状态：已验证
   - 验证：新增 `src/server/routes/api/diagnostics.ts` 与 `src/web/pages/CredentialDiagnostics.tsx`，支持站点 / 账号 / 令牌诊断
3. 模型测速与默认模型推荐
   - 状态：已验证
   - 验证：`/api/diagnostics/credential/benchmark` 已实现 1 / 3 轮轻量测速、基础过滤和推荐输出
4. 面向客户端的定向导出
   - 状态：已验证
   - 验证：`DownstreamKeys` 已接入导出助手，支持 `curl` / 环境变量 / OpenAI SDK / 客户端说明片段
5. 与路由自动排障链联动
   - 状态：已验证
   - 验证：`TokenRoutes` 已支持从治理列表、通道探测摘要、签到待办、站点运行时健康、模型熔断明细直接跳到诊断页；`CredentialDiagnostics` 已支持 URL 预选对象
6. 验证
   - 状态：已验证
   - 验证：`npm run typecheck`、`npx vitest run src/web/pages/CredentialDiagnostics.test.tsx src/web/pages/tokenRoutes.refresh-decision.test.tsx`、`npm run build` 全部通过

## 当前决策

- 不把实时诊断 / 测速塞进主请求选路链，避免给转发主链增加时延和副作用
- 采用“自动接入现有排障链”的方式：从路由治理、通道探测、稳定性诊断直接带上下文跳到诊断页
- 当前优先支持现有站点 / 账号 / 令牌对象，不含草稿态临时凭证诊断
- `channel` 治理主体通过服务端映射回账号或令牌后再跳诊断页

## 下一动作

1. 如需继续压体验，可在 `Sites` / `Accounts` / `Tokens` 列表页补直达诊断入口
2. 如需继续压自动化，可补服务端治理上下文映射测试
3. 当前主任务已满足完成定义
