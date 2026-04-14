import { OfficialApiBaseAdapter, normalizeBaseUrl } from './base.js';

function resolveOpenAiModelsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/\/v\d+(\.\d+)?$/i.test(normalized)) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
}

export class OpenAiAdapter extends OfficialApiBaseAdapter {
  readonly platformName = 'openai';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('api.openai.com');
  }

  async getModels(baseUrl: string, apiToken: string): Promise<string[]> {
    try {
      const res = await this.fetchJson<any>(resolveOpenAiModelsUrl(baseUrl), {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      return (res?.data || []).map((m: any) => m?.id).filter(Boolean);
    } catch {
      return [];
    }
  }
}
