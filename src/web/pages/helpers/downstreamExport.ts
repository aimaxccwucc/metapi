export type DownstreamExportInput = {
  keyName: string;
  gatewayBaseUrl: string;
  apiKey: string;
  recommendedModel?: string | null;
  supportedModels?: string[];
  allowedRouteTitles?: string[];
};

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function quoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildDownstreamSupportedModelsSummary(models: string[]): string {
  const normalized = models.map((item) => item.trim()).filter(Boolean);
  if (normalized.length === 0) return '未限制';
  if (normalized.length <= 4) return normalized.join(', ');
  return `${normalized.slice(0, 4).join(', ')} 等 ${normalized.length} 个`;
}

export function buildDownstreamRoutesSummary(routeTitles: string[]): string {
  const normalized = routeTitles.map((item) => item.trim()).filter(Boolean);
  if (normalized.length === 0) return '未绑定特定路由';
  if (normalized.length <= 3) return normalized.join(', ');
  return `${normalized.slice(0, 3).join(', ')} 等 ${normalized.length} 条`;
}

export function buildDownstreamCurlSnippet(input: DownstreamExportInput): string {
  const baseUrl = normalizeUrl(input.gatewayBaseUrl);
  const model = (input.recommendedModel || '').trim() || 'gpt-4o-mini';
  return [
    `curl -sS ${quoteSingle(`${baseUrl}/v1/chat/completions`)} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Authorization: Bearer ${input.apiKey}' \\`,
    `  -d '{`,
    `    \"model\": \"${model}\",`,
    `    \"messages\": [{\"role\": \"user\", \"content\": \"hello\"}]`,
    `  }'`,
  ].join('\n');
}

export function buildDownstreamEnvSnippet(input: DownstreamExportInput): string {
  const baseUrl = normalizeUrl(input.gatewayBaseUrl);
  const model = (input.recommendedModel || '').trim();
  return [
    `OPENAI_BASE_URL=${baseUrl}/v1`,
    `OPENAI_API_KEY=${input.apiKey}`,
    model ? `OPENAI_MODEL=${model}` : '',
  ].filter(Boolean).join('\n');
}

export function buildDownstreamOpenAiSdkSnippet(input: DownstreamExportInput): string {
  const baseUrl = normalizeUrl(input.gatewayBaseUrl);
  const model = (input.recommendedModel || '').trim() || 'gpt-4o-mini';
  return [
    `import OpenAI from "openai";`,
    ``,
    `const client = new OpenAI({`,
    `  apiKey: "${input.apiKey}",`,
    `  baseURL: "${baseUrl}/v1",`,
    `});`,
    ``,
    `const response = await client.chat.completions.create({`,
    `  model: "${model}",`,
    `  messages: [{ role: "user", content: "hello" }],`,
    `});`,
    ``,
    `console.log(response.choices[0]?.message?.content || "");`,
  ].join('\n');
}

export function buildDownstreamClientGuide(input: DownstreamExportInput): string {
  const model = (input.recommendedModel || '').trim() || '未指定';
  return [
    `名称：${input.keyName}`,
    `网关地址：${normalizeUrl(input.gatewayBaseUrl)}/v1`,
    `下游 Key：${input.apiKey}`,
    `推荐模型：${model}`,
    `允许模型：${buildDownstreamSupportedModelsSummary(input.supportedModels || [])}`,
    `路由范围：${buildDownstreamRoutesSummary(input.allowedRouteTitles || [])}`,
  ].join('\n');
}
