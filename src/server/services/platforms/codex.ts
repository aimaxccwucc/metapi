import { OfficialApiBaseAdapter, normalizeBaseUrl } from './base.js';

export class CodexAdapter extends OfficialApiBaseAdapter {
  readonly platformName = 'codex';

  async detect(url: string): Promise<boolean> {
    const normalized = normalizeBaseUrl(url).toLowerCase();
    return normalized.includes('chatgpt.com/backend-api/codex');
  }

  async getModels(_baseUrl: string, _token: string): Promise<string[]> {
    return [];
  }
}
