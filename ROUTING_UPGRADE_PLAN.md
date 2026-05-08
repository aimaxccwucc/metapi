# Metapi 路由网关全面分析 & 升级方案

## 一、当前系统数据概览

| 指标 | 数值 |
|------|------|
| 路由总数 | 68条（64启用） |
| 渠道总数 | 718个（706启用） |
| 账号总数 | 305个 |
| 站点总数 | 134个 |
| 治理状态 | 80条（79 suppressed, 1 probing） |

**路由策略分布：**
- `stable_first`: 41条（主策略）
- `weighted`: 18条
- `round_robin`: 5条（仅 deepseek-v4-pro）

**渠道健康分布：**
- 🟢 健康（成功率>50%）: 23个（3.2%）
- 🟡 一般（20-50%）: 7个（1.0%）
- 🔴 从未成功: 64个（8.9%）
- ⚪ **从未使用: 623个（86.8%）** ← 最大问题

---

## 二、核心问题诊断

### 问题1: stable_first 按站点而非渠道分池（根本性缺陷）

**代码位置**: `tokenRouter.ts:3602-3664` → `buildCandidateSelectionPools()`

**当前逻辑**：
```
sitePartition = partitionPreferredSuccessfulSiteCandidates(candidates)
├── preferred（有成功记录的站点）→ anchor_site_* / fallback_site_* 池
└── avoided（无成功记录的站点）→ other_site_* 池（最低优先级）
```

**问题**：
- 分池单位是**站点**（134个），不是渠道（706个）
- 未使用站点的所有渠道一律进 `other_site_other` 最低优先级池
- stable_first 的重试次数（4次）在高优先级池就用完了
- 结果：**87%的渠道永远得不到使用**

**真实数据佐证**：
- 623个渠道从未使用
- 仅23个健康渠道承担了几乎全部流量
- DuckCoding站点6个渠道只用了3个，其余3个从未尝试

### 问题2: round_robin 是"伪轮询"

**代码位置**: `tokenRouter.ts:6572-6597` → `getRoundRobinCandidates()`

**当前逻辑**：
```typescript
sort: 
1. healthScore 降序（差距>0.05时优先健康渠道）
2. lastSelectedAt 升序（最近未选的优先）
3. lastUsedAt 升序
4. channelId 升序
```

**问题**：
- 健康分数差距>0.05时，健康渠道永远排第一
- 不健康渠道永远排后面，没有恢复机会
- 真正的轮询应该是：不管健康分数，按顺序轮流使用
- 当前实现更像是"带健康排序的优先队列"

### 问题3: 探测机制形同虚设

**发现**：
- `probeMarketplaceModelAvailability` API 存在
- 对39个渠道执行探测，**全部返回 "inconclusive"**
- 原因：上游返回200但内容为空 → 探测认为"无法确定"
- 结果：`autoGovernance` 无法标记任何渠道为不可用
- 79个 governance 状态全是 "suppressed"（放行）

**问题**：
- 探测判断逻辑太保守——返回空内容不算不可用
- 探测没有区分"渠道不可用"和"模型不支持"
- 没有定期自动探测机制

### 问题4: 冷却时间过长，恢复太慢

**channelRoutingHealth.ts 冷却参数**：
- weighted模式: 15s → 15s → 30s → 45s → 75s → 120s → 180s → 300s（最高6小时）
- round_robin模式: 10分钟 → 1小时 → 24小时
- auth失败: 最少30分钟
- model_unsupported: 最少15分钟
- invalid_channel: 最多6小时

**问题**：
- 一次429限流就可能冷却90秒
- 连续失败3次就进10分钟冷却
- 上游临时故障恢复后，渠道还在冷却中
- 没有"半开探测"机制主动测试恢复

### 问题5: 路由重复配置

**deepseek-v4-pro 有5条路由**：
| 路由ID | model_pattern | 渠道数 | 策略 |
|--------|--------------|--------|------|
| 24995 | deepseek-ai/deepseek-v4-pro | 36(30启用) | round_robin |
| 24996 | deepseek-v4-pro | 36(35启用) | round_robin |
| 24997 | deepseek-v4-pro[1m] | 0 | round_robin |
| 24998 | deepseek/deepseek-v4-pro | 36(34启用) | round_robin |
| 24999 | deepseek-v4-pro | 0 | round_robin |

**问题**：
- 同一个模型有5条路由，3条有渠道
- 渠道完全重复（同一批站点/账号）
- 流量被分散，统计数据不集中
- 维护成本高

### 问题6: 错误分类复杂但效果差

**tokenRouter.ts 定义了8类错误模式**：
- `SITE_PROTOCOL_FAILURE_PATTERNS` (10个正则)
- `SITE_MODEL_FAILURE_PATTERNS` (8个正则)
- `SITE_VALIDATION_FAILURE_PATTERNS` (9个正则)
- `DEFINITIVE_TOKEN_AUTH_FAILURE_PATTERNS` (9个正则)
- `SITE_TRANSIENT_FAILURE_PATTERNS` (12个正则)
- `USAGE_LIMIT_RATE_LIMIT_PATTERNS` (5个正则)

**问题**：
- 53个正则表达式，匹配逻辑复杂
- 但实际效果：DuckCoding返回空内容、429限流、502网关错误都没被有效处理
- 错误分类后的冷却策略不够精细

### 问题7: 站点运行时健康状态管理复杂

**tokenRouter.ts 约200行常量定义**：
- 6种不同的健康衰减参数
- 3级熔断器（0/60s/5min/30min）
- 站点级+模型级双重健康评估
- 运行时健康+历史健康双重评估
- 7个持久化定时器

**问题**：
- 过度工程化，参数太多难以调优
- 运行时状态在内存中，重启丢失
- 持久化有防抖（500ms）和过期（7天）逻辑，增加复杂度

### 问题8: 账号级限流过于激进

**账号限流参数**：
- 令牌桶容量: 2-6
- 填充速率: 0.15-1.2/s
- auth失败冷却: 最少30秒
- rate_limit失败: 最少30秒
- 连续失败: 容量衰减到0.6倍

**问题**：
- 低容量账号很快被限流
- 失败后容量衰减太快
- 没有区分"账号限流"和"渠道限流"

---

## 三、升级方案

### 方案A: 渠道级分池（解决核心问题）

**改动文件**: `tokenRouter.ts` → `buildCandidateSelectionPools()`

**核心思路**: 把站点级分池改为渠道级分池

```
当前: site → preferred/avoided → 6个池
改后: channel → preferred/neutral/avoided → 3个池

preferred: 有成功记录且近期无失败的渠道（最高优先级）
neutral: 无记录或很久前失败的渠道（中等优先级，轮询试探）
avoided: 近期连续失败且冷却中的渠道（最低优先级）
```

**具体改动**:
```typescript
function buildCandidateSelectionPools(candidates, modelName, nowMs) {
  const pools = [];
  
  // 渠道级分池，不再按站点分
  const preferred = [];  // 有成功记录，近期无失败
  const neutral = [];    // 无记录（从未使用）
  const avoided = [];    // 近期失败或冷却中
  
  for (const candidate of candidates) {
    const channel = candidate.channel;
    const lastFailAt = parseIsoTimeMs(channel.lastFailAt);
    const lastSuccessAt = getChannelPersistedSuccessAtMs(channel);
    const inCooldown = channel.cooldownUntil && new Date(channel.cooldownUntil) > nowMs;
    
    if (inCooldown || (lastFailAt && (!lastSuccessAt || lastFailAt > lastSuccessAt))) {
      // 冷却中或最近失败比成功更近
      avoided.push(candidate);
    } else if (lastSuccessAt && (!lastFailAt || lastSuccessAt > lastFailAt)) {
      // 有成功记录且比失败更近
      preferred.push(candidate);
    } else {
      // 从未使用或很久没用
      neutral.push(candidate);
    }
  }
  
  // 每个池内部按轮询排序
  pushPool('preferred', roundRobinSort(preferred));
  pushPool('neutral', roundRobinSort(neutral));
  pushPool('avoided', roundRobinSort(avoided));
  
  return pools;
}
```

**预期效果**:
- 623个从未使用的渠道进入 neutral 池（中等优先级）
- 每次请求都有机会试探新渠道
- 健康渠道保持最高优先级
- 冷却中的渠道最后尝试

### 方案B: 真正的轮询 + 健康降级

**改动文件**: `tokenRouter.ts` → `getRoundRobinCandidates()`

**核心思路**: 轮询只看顺序，健康分数只用于降级而非排序

```typescript
private getRoundRobinCandidates(candidates, runtimeModelName) {
  return [...candidates].sort((left, right) => {
    // 1. 有冷却中的排最后
    const leftCooldown = left.channel.cooldownUntil && new Date(left.channel.cooldownUntil) > Date.now();
    const rightCooldown = right.channel.cooldownUntil && new Date(right.channel.cooldownUntil) > Date.now();
    if (leftCooldown !== rightCooldown) return leftCooldown ? 1 : -1;
    
    // 2. 纯粹按 lastSelectedAt 升序（最久没选的排前面）
    const leftTime = left.channel.lastSelectedAt || left.channel.lastUsedAt || '1970-01-01';
    const rightTime = right.channel.lastSelectedAt || right.channel.lastUsedAt || '1970-01-01';
    return leftTime.localeCompare(rightTime);
  });
}
```

**预期效果**:
- 真正的轮询，每个渠道按顺序被选中
- 健康分数不再影响排序，只用于冷却判断
- 从未使用的渠道自然排在前面（lastSelectedAt 为 null）

### 方案C: 主动探测 + 快速恢复

**新增**: 定时探测任务

```typescript
// 每5分钟执行一次
async function probeIdleChannels() {
  const idleChannels = await db.select()
    .from(schema.routeChannels)
    .where(and(
      eq(schema.routeChannels.enabled, true),
      isNull(schema.routeChannels.lastUsedAt),  // 从未使用
    ))
    .limit(10);  // 每次探测10个
  
  for (const channel of idleChannels) {
    const result = await probeChannel(channel);
    if (result.ok) {
      // 标记为可用，记录成功
      await recordChannelSuccess(channel.id);
    } else if (result.definitivelyBroken) {
      // 标记为不可用
      await disableChannel(channel.id);
    }
    // inconclusive 的不做处理，下次继续探测
  }
}
```

**冷却恢复探测**:
```typescript
// 每分钟检查冷却到期的渠道
async function probeCoolingChannels() {
  const now = new Date().toISOString();
  const coolingChannels = await db.select()
    .from(schema.routeChannels)
    .where(and(
      eq(schema.routeChannels.enabled, true),
      lte(schema.routeChannels.cooldownUntil, now),  // 冷却已到期
    ))
    .limit(5);
  
  for (const channel of coolingChannels) {
    // 半开探测：发一个简单请求测试
    const result = await probeChannel(channel);
    if (result.ok) {
      await recordChannelSuccess(channel.id);
      // 重置冷却
      await db.update(schema.routeChannels)
        .set({ cooldownUntil: null, consecutiveFailCount: 0 })
        .where(eq(schema.routeChannels.id, channel.id));
    }
  }
}
```

### 方案D: 简化错误处理

**当前**: 53个正则匹配8类错误
**改后**: 3类错误 + 快速失败

```typescript
function classifyError(status: number, body: string): ErrorCategory {
  // 1. 终端错误（不重试）
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (body.includes('model_not_found') || body.includes('unsupported_model')) return 'model_unsupported';
  
  // 2. 临时错误（重试其他渠道）
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server_error';
  if (body.includes('timeout') || body.includes('ECONNRESET')) return 'network';
  
  // 3. 未知错误（重试一次）
  return 'unknown';
}

function getCooldownMs(category: ErrorCategory, consecutiveFails: number): number {
  const base = {
    auth: 30 * 60 * 1000,        // 30分钟
    not_found: 60 * 60 * 1000,   // 1小时
    model_unsupported: 15 * 60 * 1000,  // 15分钟
    rate_limit: 60 * 1000,        // 1分钟
    server_error: 30 * 1000,      // 30秒
    network: 15 * 1000,           // 15秒
    unknown: 30 * 1000,           // 30秒
  }[category];
  
  // 连续失败指数退避，但有上限
  return Math.min(base * Math.pow(1.5, consecutiveFails - 1), 60 * 60 * 1000);
}
```

### 方案E: 清理重复路由

**操作**:
```sql
-- 合并 deepseek-v4-pro 路由
-- 保留 24996（渠道最多：35个enabled）
-- 把 24995 和 24998 的渠道迁移到 24996
-- 更新 24996 的 model_pattern 为通配符

-- 步骤1: 迁移渠道
UPDATE route_channels SET route_id = 24996 
WHERE route_id IN (24995, 24998);

-- 步骤2: 删除空路由
DELETE FROM token_routes WHERE id IN (24995, 24997, 24998, 24999);

-- 步骤3: 更新路由pattern
UPDATE token_routes SET model_pattern = 'deepseek.*v4.?pro.*' WHERE id = 24996;
```

---

## 四、实施优先级

### P0（立即修复）—— 解决87%渠道闲置问题

1. **渠道级分池**（方案A）
   - 修改 `buildCandidateSelectionPools()` 
   - 从未使用的渠道进入中等优先级池
   - 预期：渠道利用率从13%提升到50%+

2. **真正的轮询**（方案B）
   - 修改 `getRoundRobinCandidates()`
   - 去掉健康分数排序，纯按时间轮询
   - 预期：每个渠道都有公平的使用机会

### P1（本周完成）—— 提升探测和恢复能力

3. **主动探测**（方案C）
   - 新增定时任务探测闲置渠道
   - 冷却到期自动半开探测
   - 预期：渠道发现速度提升10倍

4. **清理重复路由**（方案E）
   - 合并 deepseek-v4-pro 的5条路由为1条
   - 统计数据更集中，维护更简单

### P2（下周完成）—— 简化和优化

5. **简化错误处理**（方案D）
   - 53个正则 → 3类错误判断
   - 冷却时间更合理
   - 代码可维护性提升

6. **监控和告警**
   - 渠道利用率监控
   - 异常渠道自动告警
   - 健康渠道占比看板

---

## 五、风险评估

| 方案 | 风险 | 缓解措施 |
|------|------|----------|
| 渠道级分池 | 新渠道首次使用可能失败率高 | neutral池权重设为preferred的50%，失败快速冷却 |
| 真轮询 | 健康渠道被跳过，整体成功率下降 | 保留冷却机制，冷却中的渠道不参与轮询 |
| 主动探测 | 增加上游请求量 | 限制每分钟探测次数（≤10），只探测闲置渠道 |
| 简化错误 | 可能误分类某些错误 | 保留unknown类，日志记录原始错误供分析 |
| 合并路由 | 迁移过程中可能丢失数据 | 先备份，分步执行，验证后删除旧路由 |

---

## 六、验证指标

实施后持续监控：

1. **渠道利用率**: 从未使用的渠道占比（目标：<30%，当前87%）
2. **首次响应时间**: 新渠道从注册到首次成功的时间（目标：<1小时）
3. **整体成功率**: 全局请求成功率（目标：>70%，当前~35%）
4. **冷却恢复时间**: 渠道从冷却到恢复使用的时间（目标：<5分钟）
5. **路由命中分布**: 各路由的请求分布是否均匀

---

## 七、代码改动清单

### tokenRouter.ts（约200行改动）
- `buildCandidateSelectionPools()` → 渠道级分池
- `getRoundRobinCandidates()` → 纯时间轮询
- `partitionPreferredSuccessfulSiteCandidates()` → 可选保留用于加权策略
- 新增 `probeIdleChannels()`
- 新增 `probeCoolingChannels()`

### channelRoutingHealth.ts（约50行改动）
- 简化冷却时间计算
- round_robin冷却从10min/1h/24h改为30s/2min/10min

### proxyRetryPolicy.ts（约100行改动）
- 简化错误分类逻辑
- 53个正则 → 10个关键模式

### 新增文件
- `services/channelProbeService.ts` — 探测服务
- `services/routeCleanupService.ts` — 路由清理工具

---

*分析时间: 2026-05-08*
*基于: metapi 源码 + 生产数据库实际数据*
