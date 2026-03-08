import { db, schema, hasProxyLogBillingDetailsColumn } from '../db/index.js';

export type ProxyLogInsertInput = {
  routeId?: number | null;
  channelId?: number | null;
  accountId?: number | null;
  modelRequested?: string | null;
  modelActual?: string | null;
  status?: string | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estimatedCost?: number | null;
  billingDetails?: unknown;
  errorMessage?: string | null;
  retryCount?: number | null;
  createdAt?: string | null;
};

function buildProxyLogBaseSelectFields() {
  return {
    id: schema.proxyLogs.id,
    routeId: schema.proxyLogs.routeId,
    channelId: schema.proxyLogs.channelId,
    accountId: schema.proxyLogs.accountId,
    modelRequested: schema.proxyLogs.modelRequested,
    modelActual: schema.proxyLogs.modelActual,
    status: schema.proxyLogs.status,
    httpStatus: schema.proxyLogs.httpStatus,
    latencyMs: schema.proxyLogs.latencyMs,
    promptTokens: schema.proxyLogs.promptTokens,
    completionTokens: schema.proxyLogs.completionTokens,
    totalTokens: schema.proxyLogs.totalTokens,
    estimatedCost: schema.proxyLogs.estimatedCost,
    errorMessage: schema.proxyLogs.errorMessage,
    retryCount: schema.proxyLogs.retryCount,
    createdAt: schema.proxyLogs.createdAt,
  };
}

export function getProxyLogBaseSelectFields() {
  return buildProxyLogBaseSelectFields();
}

export type ProxyLogSelectFields = ReturnType<typeof buildProxyLogBaseSelectFields> & {
  billingDetails?: typeof schema.proxyLogs.billingDetails;
};

export type ResolvedProxyLogSelectFields = {
  includeBillingDetails: boolean;
  fields: ProxyLogSelectFields;
};

export async function resolveProxyLogSelectFields(options?: { includeBillingDetails?: boolean }) {
  const includeBillingDetails = options?.includeBillingDetails === true
    && await hasProxyLogBillingDetailsColumn();

  return {
    includeBillingDetails,
    fields: includeBillingDetails
      ? { ...buildProxyLogBaseSelectFields(), billingDetails: schema.proxyLogs.billingDetails }
      : buildProxyLogBaseSelectFields(),
  };
}

export async function withProxyLogSelectFields<T>(
  runner: (selection: ResolvedProxyLogSelectFields) => Promise<T>,
  options?: { includeBillingDetails?: boolean },
): Promise<T> {
  const selection = await resolveProxyLogSelectFields(options);

  try {
    return await runner(selection);
  } catch (error) {
    if (selection.includeBillingDetails && isMissingBillingDetailsColumnError(error)) {
      return await runner({
        includeBillingDetails: false,
        fields: buildProxyLogBaseSelectFields(),
      });
    }
    throw error;
  }
}

export function parseProxyLogBillingDetails(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function isMissingBillingDetailsColumnError(error: unknown): boolean {
  const message = typeof error === 'object' && error && 'message' in error
    ? String((error as { message?: unknown }).message || '')
    : String(error || '');
  const lowered = message.toLowerCase();
  return lowered.includes('billing_details')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export async function insertProxyLog(input: ProxyLogInsertInput): Promise<void> {
  const baseValues = {
    routeId: input.routeId ?? null,
    channelId: input.channelId ?? null,
    accountId: input.accountId ?? null,
    modelRequested: input.modelRequested ?? null,
    modelActual: input.modelActual ?? null,
    status: input.status ?? null,
    httpStatus: input.httpStatus ?? null,
    latencyMs: input.latencyMs ?? null,
    promptTokens: input.promptTokens ?? 0,
    completionTokens: input.completionTokens ?? 0,
    totalTokens: input.totalTokens ?? 0,
    estimatedCost: input.estimatedCost ?? 0,
    errorMessage: input.errorMessage ?? null,
    retryCount: input.retryCount ?? 0,
    createdAt: input.createdAt ?? null,
  };
  const serializedBillingDetails = input.billingDetails == null
    ? null
    : JSON.stringify(input.billingDetails);
  const includeBillingDetails = serializedBillingDetails !== null
    && await hasProxyLogBillingDetailsColumn();

  try {
    await db.insert(schema.proxyLogs).values(
      includeBillingDetails
        ? { ...baseValues, billingDetails: serializedBillingDetails }
        : baseValues,
    ).run();
  } catch (error) {
    if (includeBillingDetails && isMissingBillingDetailsColumnError(error)) {
      await db.insert(schema.proxyLogs).values(baseValues).run();
      return;
    }
    throw error;
  }
}
