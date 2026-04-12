## 任务ID

metapi-comprehensive-upgrade

## 目标

全面分析 `metapi` 当前实现，结合上游项目与可借鉴开源项目，筛选适合当前仓库且满足“仅 PC 和手机访问，不需要 Windows 安装程序”的能力进行落地实现，并在完成前给出实际验证结果。

## 范围

- 当前仓库代码、文档、前后端结构、构建和测试基线
- 上游仓库近期变更与可借鉴能力
- 适合 Web 访问场景的功能、稳定性、可观测性和移动端体验改进
- 明确排除 Windows 安装程序相关能力

## 完成定义

1. 完成仓库现状基线分析并记录关键发现。
2. 完成上游/同类开源项目对标，形成候选升级项清单。
3. 至少实现一组高价值、可验证、与当前产品方向一致的改进。
4. 完成相关构建、测试或关键路径验证，并明确剩余风险。

## 里程碑

| 里程碑 | 目标 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| M1 | 仓库基线摸底 | 读取核心文件、目录、脚本、入口 | 进行中 |
| M2 | 对标上游与同类项目 | 拉取提交/README/功能差异证据 | 已验证 |
| M3 | 确定可吸收改进项 | 形成清单与优先级 | 已验证 |
| M4 | 实现改进 | 代码修改完成 | 已验证 |
| M5 | 验证与交付 | 构建/测试/关键路径验证 | 进行中 |

## 当前基线

- 技术栈：Node.js 22+、TypeScript、Fastify、React 18、Vite、Drizzle、Vitest
- 前后端同仓：`src/server` + `src/web`
- 当前 git 分支：`main`，相对 `origin/main` ahead 22
- 发现若干未跟踪的历史长跑状态文件，暂不动

## 最近验证

- `pwd`
- `git status --short --branch`
- `rg --files ...`
- 读取 `README.md`、`package.json`
- `npm run build`：通过，`dist/web` 已生成 `manifest.webmanifest` 与 `sw.js`
- `npx vitest run --root . src/web/App.mobile-layout.test.tsx src/web/App.runtime-banner.test.tsx src/web/pages/settings.factory-reset.test.tsx`：精确回归中

## 对标结论

- `upstream/main` 最近提交主要集中在 OAuth 配额/代理控制、设置卡片细化、批量 API Key 创建与路由匹配修正。
- 当前仓库相对上游已大幅演进，且已具备批量 API Key 与更强的管理/诊断能力，因此不宜机械回抄上游。
- 结合用户约束“不要 Windows 安装程序，只要 PC/手机访问”，最值得吸收的是开源 Web 应用常见的 PWA/可安装体验，而不是桌面打包链路。
- 参考同类成熟 Web AI 项目（如 `lobehub`）后，确认 `PWA + mobile adaptation + install hint` 是与当前方向一致的高价值补强项。

## 已实现改进

1. 新增 Web PWA 能力：
   - `src/web/public/manifest.webmanifest`
   - `src/web/public/sw.js`
   - `src/web/pwa.ts`
2. 前端入口补齐：
   - 注册 service worker
   - `index.html` 增加 manifest / theme-color / apple touch 能力
3. 管理后台壳层补齐安装提示：
   - 支持浏览器 `beforeinstallprompt`
   - 支持 iOS “添加到主屏幕”提示
   - 已安装后自动隐藏
   - 与现有 topbar / toast 交互风格保持一致
4. 本地状态清理补齐：
   - 工厂重置时同时清理安装提示相关本地状态
5. 构建层优化：
   - 调整 `vite` 手工分包规则
   - 保持图表渲染器独立懒加载

## 当前假设

- 仓库已有较多功能，最有价值的升级大概率落在：移动端管理体验、网关治理细节、可观测性、批量操作效率、文档/设置闭环。
- 上游仓库可能已有部分功能更新，可直接吸收或对照补齐。

## 下一动作

1. 回收精确前端测试结果。
2. 汇总本轮验证、剩余包体风险与既有红测说明。
3. 整理最终交付。

## 阻塞项

无
