import { OfficialApiBaseAdapter, normalizeBaseUrl } from './base.js';

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

function resolveClaudeModelsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/\/v\d+(\.\d+)?$/i.test(normalized)) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
}

export class ClaudeAdapter extends OfficialApiBaseAdapter {
  readonly platformName = 'claude';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('api.anthropic.com') || normalized.includes('anthropic.com/v1');
  }

  async getModels(baseUrl: string, apiToken: string): Promise<string[]> {
    try {
      const res = await this.fetchJson<any>(resolveClaudeModelsUrl(baseUrl), {
        headers: {
          'x-api-key': apiToken,
          'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
        },
      });
      return (res?.data || []).map((m: any) => m?.id).filter(Boolean);
    } catch {
      return [];
    }
  }
}
