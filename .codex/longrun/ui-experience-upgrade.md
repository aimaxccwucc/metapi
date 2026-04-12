【续跑状态】
任务ID：ui-experience-upgrade-20260410
目标：提升主要管理页面的视觉质量、移动端可用性与关键表单交互效率
范围：Dashboard / Accounts / Sites / TokenRoutes / ProgramLogs / 通用选择器与页面容器
完成定义：主要页面桌面端与手机端布局清晰；新增账号支持搜索选择；显著减少冗长提示与拥挤区块；前端测试与构建通过；必要时上线复核
当前阶段：第五轮全链路审计后的确定性缺陷修复，准备提交上线
里程碑状态：M1=已验证（审计）；M2=已验证（基础能力）；M3=已验证（账号页与筛选交互）；M4=已验证（剩余核心页 UI 收敛）；M5=已验证（第二轮交互优化与测试构建）；M6=进行中（路由兼容与搜索导航发布）
已完成：梳理主要页面与组件；确认 ModernSelect 与 SearchModal 可复用；完成主要页面骨架统一；完成 index.css 中 card/info-tip/toolbar/stat-summary-card/monitor-* 基座收敛；补齐 Accounts、TokenRoutes、DownstreamKeys、ProxyLogs 残留旧挂点；补充 Accounts/Sites/Tokens 批量栏清空选择；补充 Tokens 新增/编辑分组搜索；补充 CredentialDiagnostics 与 TaskDetailModal 首屏摘要层次；补充后台别名路由 `/token-routes`、`/monitors`、`/credential-diagnostics`、`/program-logs`、`/import-export`、`/notifications`；补全 SearchModal 键盘上下导航与 Enter 打开
剩余：提交、升级、线上抽查
当前假设：当前最明显的前端硬缺陷已从视觉协调转为地址兼容和搜索行为一致性，这轮已补齐
最近验证：`App.route-aliases` 与 `search-modal.results` 测试通过；`npm run build` 通过
下一动作：提交代码并升级线上，抽查别名入口与搜索相关页面
关键命令/文件：src/web/App.tsx, src/web/components/SearchModal.tsx, src/web/App.route-aliases.test.tsx, src/web/components/search-modal.results.test.tsx
阻塞项：无
