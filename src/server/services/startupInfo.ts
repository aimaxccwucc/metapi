type StartupSummaryInput = {
  port: number;
  host: string;
};

type StartupEndpoints = {
  baseUrl: string;
  adminDashboardUrl: string;
  adminApiExample: string;
  proxyApiExample: string;
  healthzUrl: string;
  readyzUrl: string;
  metricsUrl: string;
};

function resolveDisplayHost(host: string): string {
  const trimmed = (host || '').trim();
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::') return '127.0.0.1';
  return trimmed;
}

export function buildStartupEndpoints(input: StartupSummaryInput): StartupEndpoints {
  const displayHost = resolveDisplayHost(input.host);
  const baseUrl = `http://${displayHost}:${input.port}`;

  const adminApiExample = `${baseUrl}/api/stats/dashboard`;
  const proxyApiExample = `${baseUrl}/v1/chat/completions`;
  const healthzUrl = `${baseUrl}/healthz`;
  const readyzUrl = `${baseUrl}/readyz`;
  const metricsUrl = `${baseUrl}/metrics`;

  return {
    baseUrl,
    adminDashboardUrl: baseUrl,
    adminApiExample,
    proxyApiExample,
    healthzUrl,
    readyzUrl,
    metricsUrl,
  };
}

export function buildStartupSummaryLines(input: StartupSummaryInput): string[] {
  const endpoints = buildStartupEndpoints(input);

  return [
    `metapi running on ${input.host}:${input.port}`,
    `Dashboard: ${endpoints.adminDashboardUrl}`,
    `Admin API: ${endpoints.adminApiExample}`,
    `Proxy API: ${endpoints.proxyApiExample}`,
    `Health: ${endpoints.healthzUrl}`,
    `Ready: ${endpoints.readyzUrl}`,
    `Metrics: ${endpoints.metricsUrl}`,
    'Admin auth: use the configured admin session to access /api/*',
    'Proxy auth: use the configured PROXY_TOKEN or a managed downstream API key for /v1/*',
  ];
}
