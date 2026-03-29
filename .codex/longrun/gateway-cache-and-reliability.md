# 网关缓存与可靠性优化长跑状态

## 任务
- 标题：P1-P4 网关全面优化
- 目标：精确响应缓存、熔断状态持久化、定时主动健康探测、retry 可配置、上游 prompt cache 优化
- 范围：`src/server/db/schema.ts`、`src/server/db/responseCacheSchemaCompatibility.ts`、`src/server/db/index.ts`、`src/server/services/responseCacheService.ts`、`src/server/proxy-core/surfaces/chatSurface.ts`、`src/server/proxy-core/surfaces/geminiSurface.ts`、`src/server/services/modelCircuitBreaker.ts`、`src/server/services/siteHealthProbeScheduler.ts`（新建）、`src/server/services/checkinScheduler.ts`
- 完成定义：所有功能实现、测试通过、构建成功、部署完成

## 里程碑
1. 未开始：Task1 - response_cache schema
2. 未开始：Task2 - responseCacheService 核心
3. 未开始：Task3 - chatSurface 缓存接入
4. 未开始：Task4 - geminiSurface 缓存接入
5. 未开始：Task5 - 熔断状态持久化
6. 未开始：Task6 - 定时主动健康探测
7. 未开始：Task7 - retry 可配置
8. 未开始：Task8 - 上游 prompt cache 优化
9. 未开始：Task9 - 缓存淘汰定时任务
10. 未开始：构建+测试+提交+部署

## 下一动作
- 开始 Task1：schema 变更

## 阻塞项
- 无
