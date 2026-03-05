import { OneHubAdapter } from './oneHub.js';
import type { BalanceInfo, CheckinResult } from './base.js';

export class DoneHubAdapter extends OneHubAdapter {
  readonly platformName: string = 'done-hub';

  async detect(url: string): Promise<boolean> {
    const normalized = url.toLowerCase();
    return normalized.includes('donehub') || normalized.includes('done-hub');
  }

  // DoneHub deployments generally do not expose /api/user/checkin.
  // Mark as unsupported so higher-level logic records it as skipped instead of failed.
  override async checkin(_baseUrl: string, _accessToken: string): Promise<CheckinResult> {
    return { success: false, message: 'checkin endpoint not found' };
  }

  // DoneHub reports `quota` as remaining balance and `used_quota` as spent amount.
  // Sum them to get the total quota instead of subtracting used from quota.
  override async getBalance(baseUrl: string, accessToken: string): Promise<BalanceInfo> {
    const res = await this.fetchJson<any>(`${baseUrl}/api/user/self`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = res?.data ?? res;
    const quotaRemaining = (data?.quota || 0) / 500000;
    const used = (data?.used_quota || 0) / 500000;
    const total = quotaRemaining + used;
    const todayIncome = Number.isFinite(data?.today_income) ? (data.today_income / 500000) : undefined;
    const todayQuotaConsumption = Number.isFinite(data?.today_quota_consumption)
      ? (data.today_quota_consumption / 500000)
      : undefined;
    return { balance: quotaRemaining, used, quota: total, todayIncome, todayQuotaConsumption };
  }

  // getModels is inherited from OneHubAdapter which already has /api/available_model fallback.
  // No need to override here — OneHub's implementation handles this correctly.
}
