【续跑状态】
任务ID：ccll-key-repair
目标：修复 CCLL/new-api 自动补齐 key 链路，让高余额账号生成 ready 明文 key 并进入可用路由；清理历史 masked_pending 占位并重建
范围：代码修复、线上容器部署、线上数据库修复、真实调用验证
完成定义：至少一批高余额账号生成 ready+enabled key，进入 route_channels，并完成一次真实调用验证；历史 masked_pending 占位显著收敛并具备自动自愈能力
当前阶段：已完成主链路修复，剩余为单账号上游持续掩码的观测项
里程碑状态：M1=已验证（上游接口与数据库定位）；M2=已验证（明文 key 修复+测试+上线）；M3=已验证（93/214/122 恢复 ready 明文并进入路由）；M4=已验证（sonnet/opus 当前已优先落到 CCLL 站内账号）；M5=已验证（历史 masked_pending 已清零，失败占位不再残留）
已完成：
- tokenRouter 已改为 Claude/Codex 先锚定优选成功站点，再在站内按通道/账号排序
- newApi 已支持优先使用 `/api/token/batch/keys` 批量明文回填，再逐条 `/key` 兜底
- tokenCoverageAutoProvisionService 已在 `created_token_masked_pending` 场景下自动清理新生占位，避免残留脏数据
- 本地相关回归 72/72 通过
- 线上验证：claude-sonnet-4-6 与 claude-opus-4-6 当前均选中 CCLL.xyz，且站内账号优先消化
- 历史 masked_pending 已清零：SQL `count(*) = 0`
- account 122 已恢复本地 ready token 与 route_channels：`metapi-cckpro-shared` / `metapi-codex-shared`
当前结论：
- 全链路主问题已修复并上线
- 同站点账号成败差异的核心原因是：上游 token 接口响应速度与是否能返回明文不一致；现在慢账号已通过批量明文回填改善
- account 286 仍可能被上游持续返回掩码，autoprovision state 会记失败，但本地已不会残留 masked_pending 占位，也不影响当前主路由
最近验证：
- `npx vitest run src/server/services/platforms/newApi.test.ts src/server/services/tokenRouter.selection.test.ts src/server/routes/api/tokens.autocreate-coverage.test.ts` -> 72/72 passed
- `/api/routes/decision?model=claude-sonnet-4-6` -> `linuxdo_299 @ CCLL.xyz / metapi-cckpro-shared`
- `/api/routes/decision?model=claude-opus-4-6` -> `linuxdo_299 @ CCLL.xyz / metapi-cckpro-shared`
- SQL `select count(*) from account_tokens where value_status='masked_pending' and enabled=0 and is_default=0;` -> `0`
阻塞项：无主链路阻塞；仅剩单账号 286 的上游持续掩码行为需后续单独观测
