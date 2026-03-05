import { FastifyInstance } from 'fastify';
import cron from 'node-cron';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { updateBalanceRefreshCron, updateCheckinCron, updateSiteHealthRefreshCron } from '../../services/checkinScheduler.js';
import { sendNotification } from '../../services/notifyService.js';
import { exportBackup, importAllApiHubAccountsMerge, importBackup, type BackupExportType } from '../../services/backupService.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { extractClientIp, isIpAllowed } from '../../middleware/auth.js';

type RoutingWeights = typeof config.routingWeights;

interface RuntimeSettingsBody {
  proxyToken?: string;
  checkinCron?: string;
  balanceRefreshCron?: string;
  siteHealthRefreshCron?: string;
  webhookUrl?: string;
  barkUrl?: string;
  webhookEnabled?: boolean;
  barkEnabled?: boolean;
  serverChanEnabled?: boolean;
  serverChanKey?: string;
  telegramEnabled?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  smtpEnabled?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  smtpTo?: string;
  notifyCooldownSec?: number;
  adminIpAllowlist?: string[] | string;
  routingFallbackUnitCost?: number;
  routingWeights?: Partial<RoutingWeights>;
}

const PROXY_TOKEN_PREFIX = 'sk-';

function isValidProxyToken(value: string): boolean {
  return value.startsWith(PROXY_TOKEN_PREFIX) && value.length >= 6;
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function upsertSetting(key: string, value: unknown) {
  db.insert(schema.settings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: JSON.stringify(value) },
    })
    .run();
}

function appendSettingsEvent(input: {
  type: 'checkin' | 'balance' | 'proxy' | 'status' | 'token';
  title: string;
  message: string;
  level?: 'info' | 'warning' | 'error';
}) {
  try {
    db.insert(schema.events).values({
      type: input.type,
      title: input.title,
      message: input.message,
      level: input.level || 'info',
      relatedType: 'settings',
      createdAt: new Date().toISOString(),
    }).run();
  } catch {}
}

function toPositiveNumberOrFallback(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function isValidHttpUrl(raw: string): boolean {
  const value = String(raw || '').trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function applyImportedSettingToRuntime(key: string, value: unknown) {
  switch (key) {
    case 'checkin_cron': {
      if (typeof value !== 'string' || !value || !cron.validate(value)) return;
      config.checkinCron = value;
      updateCheckinCron(value);
      return;
    }
    case 'balance_refresh_cron': {
      if (typeof value !== 'string' || !value || !cron.validate(value)) return;
      config.balanceRefreshCron = value;
      updateBalanceRefreshCron(value);
      return;
    }
    case 'site_health_refresh_cron': {
      if (typeof value !== 'string' || !value || !cron.validate(value)) return;
      config.siteHealthRefreshCron = value;
      updateSiteHealthRefreshCron(value);
      return;
    }
    case 'proxy_token': {
      if (typeof value !== 'string') return;
      const nextToken = value.trim();
      if (!isValidProxyToken(nextToken)) return;
      config.proxyToken = nextToken;
      return;
    }
    case 'webhook_url': {
      if (typeof value !== 'string') return;
      config.webhookUrl = value.trim();
      return;
    }
    case 'webhook_enabled': {
      config.webhookEnabled = !!value;
      return;
    }
    case 'bark_url': {
      if (typeof value !== 'string') return;
      config.barkUrl = value.trim();
      return;
    }
    case 'bark_enabled': {
      config.barkEnabled = !!value;
      return;
    }
    case 'serverchan_enabled': {
      config.serverChanEnabled = !!value;
      return;
    }
    case 'serverchan_key': {
      if (typeof value !== 'string') return;
      config.serverChanKey = value.trim();
      return;
    }
    case 'telegram_enabled': {
      config.telegramEnabled = !!value;
      return;
    }
    case 'telegram_bot_token': {
      if (typeof value !== 'string') return;
      config.telegramBotToken = value.trim();
      return;
    }
    case 'telegram_chat_id': {
      if (typeof value !== 'string') return;
      config.telegramChatId = value.trim();
      return;
    }
    case 'smtp_enabled': {
      config.smtpEnabled = !!value;
      return;
    }
    case 'smtp_host': {
      if (typeof value !== 'string') return;
      config.smtpHost = value.trim();
      return;
    }
    case 'smtp_port': {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return;
      config.smtpPort = Math.trunc(n);
      return;
    }
    case 'smtp_secure': {
      config.smtpSecure = !!value;
      return;
    }
    case 'smtp_user': {
      if (typeof value !== 'string') return;
      config.smtpUser = value.trim();
      return;
    }
    case 'smtp_pass': {
      if (typeof value !== 'string') return;
      config.smtpPass = value.trim();
      return;
    }
    case 'smtp_from': {
      if (typeof value !== 'string') return;
      config.smtpFrom = value.trim();
      return;
    }
    case 'smtp_to': {
      if (typeof value !== 'string') return;
      config.smtpTo = value.trim();
      return;
    }
    case 'notify_cooldown_sec': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return;
      config.notifyCooldownSec = Math.trunc(n);
      return;
    }
    case 'admin_ip_allowlist': {
      config.adminIpAllowlist = toStringList(value);
      return;
    }
    case 'routing_weights': {
      if (!value || typeof value !== 'object') return;
      const rw = value as Partial<RoutingWeights>;
      config.routingWeights = {
        baseWeightFactor: toPositiveNumberOrFallback(rw.baseWeightFactor, config.routingWeights.baseWeightFactor),
        valueScoreFactor: toPositiveNumberOrFallback(rw.valueScoreFactor, config.routingWeights.valueScoreFactor),
        costWeight: toPositiveNumberOrFallback(rw.costWeight, config.routingWeights.costWeight),
        balanceWeight: toPositiveNumberOrFallback(rw.balanceWeight, config.routingWeights.balanceWeight),
        usageWeight: toPositiveNumberOrFallback(rw.usageWeight, config.routingWeights.usageWeight),
      };
      return;
    }
    case 'routing_fallback_unit_cost': {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return;
      config.routingFallbackUnitCost = Math.max(1e-6, n);
      return;
    }
    default:
      return;
  }
}

function getRuntimeSettingsResponse(currentAdminIp = '') {
  return {
    checkinCron: config.checkinCron,
    balanceRefreshCron: config.balanceRefreshCron,
    siteHealthRefreshCron: config.siteHealthRefreshCron,
    routingFallbackUnitCost: config.routingFallbackUnitCost,
    routingWeights: config.routingWeights,
    webhookUrl: config.webhookUrl,
    barkUrl: config.barkUrl,
    webhookEnabled: config.webhookEnabled,
    barkEnabled: config.barkEnabled,
    serverChanEnabled: config.serverChanEnabled,
    serverChanKeyMasked: maskSecret(config.serverChanKey),
    telegramEnabled: config.telegramEnabled,
    telegramBotTokenMasked: maskSecret(config.telegramBotToken),
    telegramChatId: config.telegramChatId,
    smtpEnabled: config.smtpEnabled,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpSecure: config.smtpSecure,
    smtpUser: config.smtpUser,
    smtpPassMasked: maskSecret(config.smtpPass),
    smtpFrom: config.smtpFrom,
    smtpTo: config.smtpTo,
    notifyCooldownSec: config.notifyCooldownSec,
    adminIpAllowlist: config.adminIpAllowlist,
    currentAdminIp,
    proxyTokenMasked: maskSecret(config.proxyToken),
  };
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings/runtime', async (request) => {
    const currentAdminIp = extractClientIp(request.ip, request.headers['x-forwarded-for']);
    return getRuntimeSettingsResponse(currentAdminIp);
  });

  app.put<{ Body: RuntimeSettingsBody }>('/api/settings/runtime', async (request, reply) => {
    const body = request.body || {};
    const changedLabels: string[] = [];
    const currentRequestIp = extractClientIp(request.ip, request.headers['x-forwarded-for']);

    const webhookTouched = body.webhookUrl !== undefined || body.webhookEnabled !== undefined;
    const nextWebhookUrl = body.webhookUrl !== undefined
      ? String(body.webhookUrl || '').trim()
      : config.webhookUrl;
    const nextWebhookEnabled = body.webhookEnabled !== undefined
      ? !!body.webhookEnabled
      : config.webhookEnabled;
    if (webhookTouched && nextWebhookEnabled) {
      if (!nextWebhookUrl) {
        return reply.code(400).send({ success: false, message: 'Webhook URL 不能为空（启用 Webhook 时）' });
      }
      if (!isValidHttpUrl(nextWebhookUrl)) {
        return reply.code(400).send({ success: false, message: 'Webhook URL 无效，请填写 http/https 地址' });
      }
    }

    const barkTouched = body.barkUrl !== undefined || body.barkEnabled !== undefined;
    const nextBarkUrl = body.barkUrl !== undefined
      ? String(body.barkUrl || '').trim()
      : config.barkUrl;
    const nextBarkEnabled = body.barkEnabled !== undefined
      ? !!body.barkEnabled
      : config.barkEnabled;
    if (barkTouched && nextBarkEnabled) {
      if (!nextBarkUrl) {
        return reply.code(400).send({ success: false, message: 'Bark URL 不能为空（启用 Bark 时）' });
      }
      if (!isValidHttpUrl(nextBarkUrl)) {
        return reply.code(400).send({ success: false, message: 'Bark URL 无效，请填写 http/https 地址' });
      }
    }

    const telegramTouched = body.telegramEnabled !== undefined
      || body.telegramBotToken !== undefined
      || body.telegramChatId !== undefined;
    const nextTelegramEnabled = body.telegramEnabled !== undefined
      ? !!body.telegramEnabled
      : config.telegramEnabled;
    const nextTelegramBotToken = body.telegramBotToken !== undefined
      ? String(body.telegramBotToken || '').trim()
      : config.telegramBotToken;
    const nextTelegramChatId = body.telegramChatId !== undefined
      ? String(body.telegramChatId || '').trim()
      : config.telegramChatId;
    if (telegramTouched && nextTelegramEnabled) {
      if (!nextTelegramBotToken) {
        return reply.code(400).send({ success: false, message: 'Telegram Bot Token 不能为空（启用 Telegram 时）' });
      }
      if (!nextTelegramBotToken.includes(':')) {
        return reply.code(400).send({ success: false, message: 'Telegram Bot Token 格式无效（示例：123456:abcDEF）' });
      }
      if (!nextTelegramChatId) {
        return reply.code(400).send({ success: false, message: 'Telegram Chat ID 不能为空（启用 Telegram 时）' });
      }
    }

    if (body.checkinCron !== undefined) {
      if (!cron.validate(body.checkinCron)) {
        return reply.code(400).send({ success: false, message: '签到 Cron 表达式无效' });
      }
      if (body.checkinCron !== config.checkinCron) {
        changedLabels.push(`签到 Cron（${config.checkinCron} -> ${body.checkinCron}）`);
      }
      updateCheckinCron(body.checkinCron);
      upsertSetting('checkin_cron', body.checkinCron);
    }

    if (body.balanceRefreshCron !== undefined) {
      if (!cron.validate(body.balanceRefreshCron)) {
        return reply.code(400).send({ success: false, message: '余额刷新 Cron 表达式无效' });
      }
      if (body.balanceRefreshCron !== config.balanceRefreshCron) {
        changedLabels.push(`余额刷新 Cron（${config.balanceRefreshCron} -> ${body.balanceRefreshCron}）`);
      }
      updateBalanceRefreshCron(body.balanceRefreshCron);
      upsertSetting('balance_refresh_cron', body.balanceRefreshCron);
    }

    if (body.siteHealthRefreshCron !== undefined) {
      if (!cron.validate(body.siteHealthRefreshCron)) {
        return reply.code(400).send({ success: false, message: '站点健康检测 Cron 表达式无效' });
      }
      if (body.siteHealthRefreshCron !== config.siteHealthRefreshCron) {
        changedLabels.push(`站点健康检测 Cron（${config.siteHealthRefreshCron} -> ${body.siteHealthRefreshCron}）`);
      }
      updateSiteHealthRefreshCron(body.siteHealthRefreshCron);
      upsertSetting('site_health_refresh_cron', body.siteHealthRefreshCron);
    }

    if (body.proxyToken !== undefined) {
      const proxyToken = String(body.proxyToken).trim();
      if (!proxyToken.startsWith(PROXY_TOKEN_PREFIX)) {
        return reply.code(400).send({ success: false, message: '下游访问令牌必须以 sk- 开头' });
      }
      if (proxyToken.length < 6) {
        return reply.code(400).send({ success: false, message: '下游访问令牌至少 6 位（含 sk-）' });
      }
      if (proxyToken !== config.proxyToken) {
        changedLabels.push('代理访问 Token');
      }
      config.proxyToken = proxyToken;
      upsertSetting('proxy_token', proxyToken);
    }

    if (body.webhookUrl !== undefined) {
      if (String(body.webhookUrl || '').trim() !== config.webhookUrl) {
        changedLabels.push('Webhook 地址');
      }
      config.webhookUrl = String(body.webhookUrl || '').trim();
      upsertSetting('webhook_url', config.webhookUrl);
    }

    if (body.webhookEnabled !== undefined) {
      if (!!body.webhookEnabled !== config.webhookEnabled) {
        changedLabels.push('Webhook 开关');
      }
      config.webhookEnabled = !!body.webhookEnabled;
      upsertSetting('webhook_enabled', config.webhookEnabled);
    }

    if (body.barkUrl !== undefined) {
      if (String(body.barkUrl || '').trim() !== config.barkUrl) {
        changedLabels.push('Bark 地址');
      }
      config.barkUrl = String(body.barkUrl || '').trim();
      upsertSetting('bark_url', config.barkUrl);
    }

    if (body.barkEnabled !== undefined) {
      if (!!body.barkEnabled !== config.barkEnabled) {
        changedLabels.push('Bark 开关');
      }
      config.barkEnabled = !!body.barkEnabled;
      upsertSetting('bark_enabled', config.barkEnabled);
    }

    if (body.serverChanEnabled !== undefined) {
      if (!!body.serverChanEnabled !== config.serverChanEnabled) {
        changedLabels.push('Server 酱开关');
      }
      config.serverChanEnabled = !!body.serverChanEnabled;
      upsertSetting('serverchan_enabled', config.serverChanEnabled);
    }

    if (body.serverChanKey !== undefined) {
      if (String(body.serverChanKey || '').trim() !== config.serverChanKey) {
        changedLabels.push('Server 酱密钥');
      }
      config.serverChanKey = String(body.serverChanKey || '').trim();
      upsertSetting('serverchan_key', config.serverChanKey);
    }

    if (body.telegramEnabled !== undefined) {
      if (!!body.telegramEnabled !== config.telegramEnabled) {
        changedLabels.push('Telegram 开关');
      }
      config.telegramEnabled = !!body.telegramEnabled;
      upsertSetting('telegram_enabled', config.telegramEnabled);
    }

    if (body.telegramBotToken !== undefined) {
      if (String(body.telegramBotToken || '').trim() !== config.telegramBotToken) {
        changedLabels.push('Telegram Bot Token');
      }
      config.telegramBotToken = String(body.telegramBotToken || '').trim();
      upsertSetting('telegram_bot_token', config.telegramBotToken);
    }

    if (body.telegramChatId !== undefined) {
      if (String(body.telegramChatId || '').trim() !== config.telegramChatId) {
        changedLabels.push('Telegram Chat ID');
      }
      config.telegramChatId = String(body.telegramChatId || '').trim();
      upsertSetting('telegram_chat_id', config.telegramChatId);
    }

    if (body.smtpEnabled !== undefined) {
      if (!!body.smtpEnabled !== config.smtpEnabled) {
        changedLabels.push('SMTP 开关');
      }
      config.smtpEnabled = !!body.smtpEnabled;
      upsertSetting('smtp_enabled', config.smtpEnabled);
    }

    if (body.smtpHost !== undefined) {
      if (String(body.smtpHost || '').trim() !== config.smtpHost) {
        changedLabels.push('SMTP 主机');
      }
      config.smtpHost = String(body.smtpHost || '').trim();
      upsertSetting('smtp_host', config.smtpHost);
    }

    if (body.smtpPort !== undefined) {
      const smtpPort = Number(body.smtpPort);
      if (!Number.isFinite(smtpPort) || smtpPort <= 0) {
        return reply.code(400).send({ success: false, message: 'SMTP 端口无效' });
      }
      if (Math.trunc(smtpPort) !== config.smtpPort) {
        changedLabels.push(`SMTP 端口（${config.smtpPort} -> ${Math.trunc(smtpPort)}）`);
      }
      config.smtpPort = Math.trunc(smtpPort);
      upsertSetting('smtp_port', config.smtpPort);
    }

    if (body.smtpSecure !== undefined) {
      if (!!body.smtpSecure !== config.smtpSecure) {
        changedLabels.push('SMTP 安全连接');
      }
      config.smtpSecure = !!body.smtpSecure;
      upsertSetting('smtp_secure', config.smtpSecure);
    }

    if (body.smtpUser !== undefined) {
      if (String(body.smtpUser || '').trim() !== config.smtpUser) {
        changedLabels.push('SMTP 用户');
      }
      config.smtpUser = String(body.smtpUser || '').trim();
      upsertSetting('smtp_user', config.smtpUser);
    }

    if (body.smtpPass !== undefined) {
      if (String(body.smtpPass || '').trim() !== config.smtpPass) {
        changedLabels.push('SMTP 密码');
      }
      config.smtpPass = String(body.smtpPass || '').trim();
      upsertSetting('smtp_pass', config.smtpPass);
    }

    if (body.smtpFrom !== undefined) {
      if (String(body.smtpFrom || '').trim() !== config.smtpFrom) {
        changedLabels.push('发件人地址');
      }
      config.smtpFrom = String(body.smtpFrom || '').trim();
      upsertSetting('smtp_from', config.smtpFrom);
    }

    if (body.smtpTo !== undefined) {
      if (String(body.smtpTo || '').trim() !== config.smtpTo) {
        changedLabels.push('收件人地址');
      }
      config.smtpTo = String(body.smtpTo || '').trim();
      upsertSetting('smtp_to', config.smtpTo);
    }

    if (body.notifyCooldownSec !== undefined) {
      const notifyCooldownSec = Number(body.notifyCooldownSec);
      if (!Number.isFinite(notifyCooldownSec) || notifyCooldownSec < 0) {
        return reply.code(400).send({ success: false, message: '告警冷静期必须是大于等于 0 的数字（秒）' });
      }
      const nextCooldown = Math.trunc(notifyCooldownSec);
      if (nextCooldown !== config.notifyCooldownSec) {
        changedLabels.push(`告警冷静期（${config.notifyCooldownSec}s -> ${nextCooldown}s）`);
      }
      config.notifyCooldownSec = nextCooldown;
      upsertSetting('notify_cooldown_sec', config.notifyCooldownSec);
    }

    if (body.adminIpAllowlist !== undefined) {
      const nextAllowlist = toStringList(body.adminIpAllowlist);
      if (nextAllowlist.length > 0 && !isIpAllowed(currentRequestIp, nextAllowlist)) {
        return reply.code(400).send({
          success: false,
          message: `保存失败：当前请求 IP（${currentRequestIp || 'unknown'}）不在新白名单中。请至少保留当前 IP，避免把自己锁出后台。`,
        });
      }
      if (JSON.stringify(nextAllowlist) !== JSON.stringify(config.adminIpAllowlist)) {
        changedLabels.push('管理端 IP 白名单');
      }
      config.adminIpAllowlist = nextAllowlist;
      upsertSetting('admin_ip_allowlist', nextAllowlist);
    }

    if (body.routingWeights !== undefined) {
      const nextWeights: RoutingWeights = {
        baseWeightFactor: toPositiveNumberOrFallback(body.routingWeights.baseWeightFactor, config.routingWeights.baseWeightFactor),
        valueScoreFactor: toPositiveNumberOrFallback(body.routingWeights.valueScoreFactor, config.routingWeights.valueScoreFactor),
        costWeight: toPositiveNumberOrFallback(body.routingWeights.costWeight, config.routingWeights.costWeight),
        balanceWeight: toPositiveNumberOrFallback(body.routingWeights.balanceWeight, config.routingWeights.balanceWeight),
        usageWeight: toPositiveNumberOrFallback(body.routingWeights.usageWeight, config.routingWeights.usageWeight),
      };
      if (JSON.stringify(nextWeights) !== JSON.stringify(config.routingWeights)) {
        changedLabels.push('路由权重');
      }
      config.routingWeights = nextWeights;
      upsertSetting('routing_weights', nextWeights);
    }

    if (body.routingFallbackUnitCost !== undefined) {
      const nextRoutingFallbackUnitCost = Number(body.routingFallbackUnitCost);
      if (!Number.isFinite(nextRoutingFallbackUnitCost) || nextRoutingFallbackUnitCost <= 0) {
        return reply.code(400).send({ success: false, message: '无价模型默认单价必须是大于 0 的数字' });
      }
      const normalized = Math.max(1e-6, nextRoutingFallbackUnitCost);
      if (Math.abs(normalized - config.routingFallbackUnitCost) > 1e-12) {
        changedLabels.push(`无价模型默认单价（${config.routingFallbackUnitCost} -> ${normalized}）`);
      }
      config.routingFallbackUnitCost = normalized;
      upsertSetting('routing_fallback_unit_cost', normalized);
    }

    if (changedLabels.length > 0) {
      let eventType: 'checkin' | 'balance' | 'proxy' | 'status' | 'token' = 'status';
      if (changedLabels.length === 1) {
        if (changedLabels[0].startsWith('签到 Cron')) eventType = 'checkin';
        else if (changedLabels[0].startsWith('余额刷新 Cron')) eventType = 'balance';
        else if (changedLabels[0] === '代理访问 Token') eventType = 'proxy';
      }
      appendSettingsEvent({
        type: eventType,
        title: '运行时设置已更新',
        message: `已更新：${changedLabels.join('、')}`,
      });
    }

    return {
      success: true,
      message: '运行时设置已更新',
      ...getRuntimeSettingsResponse(currentRequestIp),
    };
  });

  app.get<{ Querystring: { type?: string } }>('/api/settings/backup/export', async (request, reply) => {
    const rawType = String(request.query.type || 'all').trim().toLowerCase();
    const type: BackupExportType = rawType === 'accounts' || rawType === 'preferences' ? rawType : 'all';
    if (rawType && !['all', 'accounts', 'preferences'].includes(rawType)) {
      return reply.code(400).send({ success: false, message: '导出类型无效，仅支持 all/accounts/preferences' });
    }
    return exportBackup(type);
  });

  app.post<{ Body: { data?: Record<string, unknown> } }>('/api/settings/backup/import', async (request, reply) => {
    const payload = request.body?.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return reply.code(400).send({ success: false, message: '导入数据格式错误：需要 JSON 对象' });
    }

    try {
      const result = importBackup(payload);
      for (const item of result.appliedSettings) {
        applyImportedSettingToRuntime(item.key, item.value);
      }
      return {
        success: true,
        message: '导入完成',
        ...result,
      };
    } catch (err: any) {
      return reply.code(400).send({
        success: false,
        message: err?.message || '导入失败',
      });
    }
  });

  app.post<{ Body: { data?: Record<string, unknown> } }>('/api/settings/backup/import-all-api-hub-merge', async (request, reply) => {
    const payload = request.body?.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return reply.code(400).send({ success: false, message: '导入数据格式错误：需要 JSON 对象' });
    }

    try {
      const result = importAllApiHubAccountsMerge(payload);
      return {
        success: true,
        message: 'all-api-hub 账号已合并导入',
        ...result,
      };
    } catch (err: any) {
      return reply.code(400).send({
        success: false,
        message: err?.message || '导入失败',
      });
    }
  });

  app.post('/api/settings/notify/test', async (_, reply) => {
    try {
      const result = await sendNotification(
        '测试通知',
        '您好，这是一条来自系统设置的连通性测试通知，您的通知相关配置目前工作正常！',
        'info',
        {
          bypassThrottle: true,
          requireChannel: true,
          throwOnFailure: true,
        },
      );
      return {
        success: true,
        message: `测试通知已发送（成功 ${result.succeeded}/${result.attempted}）`,
      };
    } catch (err: any) {
      return reply.code(400).send({
        success: false,
        message: err?.message || '测试通知发送失败',
      });
    }
  });

  app.post('/api/settings/maintenance/clear-cache', async (_, reply) => {
    const deletedModelAvailability = db.delete(schema.modelAvailability).run().changes;
    const deletedRouteChannels = db.delete(schema.routeChannels).run().changes;
    const deletedTokenRoutes = db.delete(schema.tokenRoutes).run().changes;

    const { task, reused } = startBackgroundTask(
      {
        type: 'maintenance',
        title: '清理缓存并重建路由',
        dedupeKey: 'refresh-models-and-rebuild-routes',
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const rebuild = (currentTask.result as any)?.rebuild;
          if (!rebuild) return '缓存清理后重建路由已完成';
          return `缓存清理后重建完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
        },
        failureMessage: (currentTask) => `缓存清理后重建失败：${currentTask.error || 'unknown error'}`,
      },
      async () => refreshModelsAndRebuildRoutes(),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      message: '缓存已清理，重建路由已开始执行',
      deletedModelAvailability,
      deletedRouteChannels,
      deletedTokenRoutes,
    });
  });

  app.post('/api/settings/maintenance/clear-usage', async () => {
    const deletedProxyLogs = db.delete(schema.proxyLogs).run().changes;

    db.update(schema.routeChannels).set({
      successCount: 0,
      failCount: 0,
      totalLatencyMs: 0,
      totalCost: 0,
      lastUsedAt: null,
      lastFailAt: null,
      cooldownUntil: null,
    }).run();

    db.update(schema.accounts).set({
      balanceUsed: 0,
      updatedAt: new Date().toISOString(),
    }).run();

    appendSettingsEvent({
      type: 'status',
      title: '占用统计与使用日志已清理',
      message: `已清理使用日志 ${deletedProxyLogs} 条，并重置路由与账号占用统计`,
      level: 'warning',
    });

    return {
      success: true,
      message: '占用统计已清理',
      deletedProxyLogs,
    };
  });
}
