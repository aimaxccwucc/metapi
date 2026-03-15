# 定制开发与上游合并手册

本手册用于约束本仓库后续的定制化开发方式，目标是降低与上游 `cita-777/metapi` 合并时的冲突面，并把冲突收敛到少数接缝文件。

## 目标

- 自定义功能尽量落在独立文件，不直接堆进上游核心文件。
- 入口文件只保留少量注册或注入调用，避免把业务实现散落在大文件里。
- 与上游同步时，优先只检查少数接缝文件，而不是重新梳理整套定制逻辑。

## 当前建议目录

后端新增功能优先放到以下目录：

- `src/server/custom/routes`
- `src/server/custom/register.ts`
- `src/server/services` 中仅放可复用、与上游现有 service 风格一致的独立能力

前端新增功能建议优先放到以下目录或同级独立文件：

- `src/web/components`
- `src/web/pages` 下的独立页面文件
- 如果后续定制功能继续增长，新增 `src/web/custom` 或 `src/web/features`，不要持续把定制逻辑堆进现有大页面

## 开发规范

### 1. 新接口优先新建独立路由文件

如果新增的是管理接口、维护接口、导入导出接口，优先放到 `src/server/custom/routes`，不要直接改：

- `src/server/routes/api/accounts.ts`
- `src/server/routes/api/sites.ts`
- `src/server/routes/api/settings.ts`
- `src/server/routes/api/stats.ts`

推荐方式：

1. 在 `src/server/custom/routes` 新建一个独立文件。
2. 在文件内只注册该定制接口。
3. 复用现有 service，不要把底层实现再次复制到入口文件。
4. 在 `src/server/custom/register.ts` 统一注册。
5. 在 `src/server/index.ts` 保留一行 `await app.register(registerCustomRoutes)` 作为接缝。

### 2. 业务实现优先下沉到 service

如果新增的是业务能力，不要把主要逻辑直接写在路由处理函数里。

推荐方式：

- 路由文件只做参数校验、调用 service、整理响应。
- 真正的业务流程放进 `src/server/services/*.ts`。
- 如果是明显只属于定制功能的 service，可以后续增加 `src/server/custom/services`，避免把仓库所有定制逻辑继续混入通用 service。

### 3. 尽量不要深改高冲突文件

以下文件是高冲突区域，除非必须，否则不要做大面积直接修改：

- `src/server/services/tokenRouter.ts`
- `src/server/routes/api/stats.ts`
- `src/server/routes/api/accounts.ts`
- `src/server/routes/api/sites.ts`
- `src/server/routes/api/settings.ts`
- `src/server/index.ts`
- `src/web/pages/Models.tsx`
- `src/web/pages/ProgramLogs.tsx`

如果必须改这些文件，遵守以下原则：

- 只增加最小接缝代码。
- 不在核心文件里内联整段新业务。
- 先抽出独立函数或独立文件，再在核心文件中调用。
- 单次修改尽量只做一类事情，不要顺手重构其它逻辑。

### 4. 测试与自定义路由一起落地

每个新增接口或新增定制功能，至少补一类测试：

- 路由测试：验证路径、状态码、核心响应结构。
- service 测试：验证核心业务规则。

如果测试需要注册定制路由，统一通过 `registerCustomRoutes` 接入，避免测试把自定义逻辑重新散落到多个入口。

## 已落地的低侵入模式

目前以下自定义接口已经从上游核心路由文件中抽离到 `src/server/custom/routes`：

- `/api/accounts/keys/repair`
- `/api/sites/health/refresh`
- `/api/sites/cleanup-unreachable`
- `/api/settings/backup/import-all-api-hub-merge`
- `/api/settings/maintenance/factory-reset`
- `/api/settings/maintenance/clear-cache`
- `/api/settings/maintenance/clear-usage`

对应接缝文件为：

- `src/server/custom/register.ts`
- `src/server/index.ts`

其中 `settings` 相关的定制维护接口应继续统一收口到 `src/server/custom/routes/settingsCustom.ts`，不要再回写到 `src/server/routes/api/settings.ts`。

已经归入该文件的类型包括：

- 导入类维护接口
- 系统重置类接口
- 缓存清理与重建类接口
- 使用统计清理类接口

后续新增同类接口时，直接按这个模式继续扩展，不要再回写到 `accounts.ts`、`sites.ts`、`settings.ts` 里。

## 上游合并 SOP

### 合并前

1. 提交或暂存本地修改，确保工作树可控。
2. 拉取上游最新代码：

```bash
git fetch upstream
```

3. 从当前主分支切一个合并分支：

```bash
git switch -c chore/merge-upstream-YYYYMMDD
```

### 合并时

执行：

```bash
git merge upstream/main
```

如果有冲突，优先检查这些接缝文件：

- `src/server/index.ts`
- `src/server/custom/register.ts`
- `src/server/custom/routes/*`
- 前端自定义入口文件

处理顺序建议：

1. 先保留上游核心逻辑更新。
2. 再把本地自定义注册调用补回去。
3. 不要第一时间回头改大块核心实现。
4. 如果发现定制逻辑依赖的上游函数签名变了，只在自定义文件里调整适配。

### 合并后

至少执行以下检查：

```bash
npm test -- src/server/routes/api/accounts.keys-repair.test.ts src/server/routes/api/sites.health-cleanup.test.ts src/server/routes/api/settings.import-all-api-hub-merge.test.ts
```

如果本次合并触及更多高风险区域，再补：

- 相关 service 测试
- 相关前端页面测试或手工回归
- 一次完整 `npm test`

## 代码评审规则

以后凡是新增定制代码，评审时优先问下面几个问题：

1. 这段逻辑能不能放到独立文件，而不是继续改核心大文件？
2. 入口文件是不是只增加了最少量的注册调用？
3. 业务逻辑是不是已经下沉到 service，而不是写死在路由里？
4. 这次改动会不会扩大以后与上游合并时的冲突面？

如果答案不够理想，应优先调整结构，再合入功能。

## 不建议的做法

- 直接在 `tokenRouter.ts` 中插入大段定制路由决策逻辑。
- 在 `accounts.ts`、`sites.ts`、`settings.ts` 中继续追加新的定制接口。
- 在 `Models.tsx`、`ProgramLogs.tsx` 里持续堆叠页面级定制逻辑而不拆文件。
- 合并上游时先处理定制逻辑、后看上游变更。
- 在一次 PR 里同时做上游同步、结构重构和功能新增。

## 后续演进建议

这次只完成了第一批低风险抽离。后续如果继续治理，可以按下面顺序推进：

1. 把更多纯新增接口继续迁入 `src/server/custom/routes`。
2. 为定制业务补 `src/server/custom/services`，进一步减少对通用 service 的侵入。
3. 为前端定制页面建立 `src/web/custom` 或 `src/web/features`。
4. 最后再评估是否要对 `tokenRouter.ts`、`stats.ts` 做更细粒度的扩展点设计。

不要一次性做全量插件化改造。优先选择低风险、可逐步迁移的结构调整。
