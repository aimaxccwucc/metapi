import type { PreparedProviderRequest, PrepareProviderRequestInput, ProviderAction, ProviderProfile } from './types.js';
import { asTrimmedString, getInputHeader } from '../executors/types.js';

function parseGeminiCliUserAgentRuntime(userAgent: string | null): {
  version: string;
  platform: string;
  arch: string;
} | null {
  if (!userAgent) return null;
  const match = /^GeminiCLI\/([^/]+)\/[^ ]+ \(([^;]+); ([^)]+)\)$/i.exec(userAgent.trim());
  if (!match) return null;
  return {
    version: match[1] || '0.31.0',
    platform: match[2] || 'win32',
    arch: match[3] || 'x64',
  };
}

function buildGeminiCLIUserAgent(modelName: string, existingUserAgent?: string | null): string {
  const parsed = parseGeminiCliUserAgentRuntime(existingUserAgent ?? null);
  const version = parsed?.version || '0.31.0';
  const platform = parsed?.platform || 'win32';
  const arch = parsed?.arch || 'x64';
  const effectiveModel = asTrimmedString(modelName) || 'unknown';
  return `GeminiCLI/${version}/${effectiveModel} (${platform}; ${arch})`;
}

function resolveAction(action: ProviderAction | undefined, stream: boolean): ProviderAction {
  if (action) return action;
  return stream ? 'streamGenerateContent' : 'generateContent';
}

function resolvePath(action: ProviderAction): string {
  if (action === 'countTokens') return '/v1internal:countTokens';
  if (action === 'streamGenerateContent') return '/v1internal:streamGenerateContent?alt=sse';
  return '/v1internal:generateContent';
}

export const geminiCliProviderProfile: ProviderProfile = {
  id: 'gemini-cli',
  prepareRequest(input: PrepareProviderRequestInput): PreparedProviderRequest {
    const projectId = asTrimmedString(input.oauthProjectId);
    if (!projectId) {
      throw new Error('gemini-cli oauth project id missing');
    }
    const action = resolveAction(input.action, input.stream);
    const apiClient = (
      getInputHeader(input.providerHeaders, 'x-goog-api-client')
      || getInputHeader(input.baseHeaders, 'x-goog-api-client')
    );
    const userAgent = buildGeminiCLIUserAgent(
      input.modelName,
      getInputHeader(input.providerHeaders, 'user-agent') || getInputHeader(input.baseHeaders, 'user-agent'),
    );
    const headers: Record<string, string> = {
      Authorization: input.baseHeaders.Authorization,
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
    };
    if (apiClient) {
      headers['X-Goog-Api-Client'] = apiClient;
    }
    if (action === 'streamGenerateContent') {
      headers.Accept = 'text/event-stream';
    }
    return {
      path: resolvePath(action),
      headers,
      body: {
        project: projectId,
        model: input.modelName,
        request: input.body,
      },
      runtime: {
        executor: 'gemini-cli',
        modelName: input.modelName,
        stream: action === 'streamGenerateContent',
        oauthProjectId: projectId,
        action,
      },
    };
  },
};
