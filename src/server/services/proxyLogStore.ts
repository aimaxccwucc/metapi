import {
  db,
  schema,
  hasProxyLogBillingDetailsColumn,
  hasProxyLogCacheColumns,
  hasProxyLogClientColumns,
  hasProxyLogDownstreamApiKeyIdColumn,
  hasProxyLogRouteContextColumns,
} from '../db/index.js';

export type ProxyLogInsertInput = {
  routeId?: number | null;
  entryRouteId?: number | null;
  sourceRouteId?: number | null;
  channelId?: number | null;
  accountId?: number | null;
  downstreamApiKeyId?: number | null;
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
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: string | null;
  cacheStatus?: string | null;
  cacheSavedCost?: number | null;
  errorMessage?: string | null;
  retryCount?: number | null;
  createdAt?: string | null;
};

type ProxyLogSelectedRouteContext = {
  entryRouteId?: number | null;
  sourceRouteId?: number | null;
  channel?: { routeId?: number | null } | null;
} | null | undefined;

export function resolveProxyLogRouteContext(selected: ProxyLogSelectedRouteContext): {
  routeId: number | null;
  entryRouteId: number | null;
  sourceRouteId: number | null;
} {
  const channelRouteId = typeof selected?.channel?.routeId === 'number'
    ? selected.channel.routeId
    : null;
  const sourceRouteId = typeof selected?.sourceRouteId === 'number'
    ? selected.sourceRouteId
    : channelRouteId;
  const entryRouteId = typeof selected?.entryRouteId === 'number'
    ? selected.entryRouteId
    : sourceRouteId;

  return {
    routeId: sourceRouteId,
    entryRouteId,
    sourceRouteId,
  };
}

function buildProxyLogCoreSelectFields() {
  return {
    id: schema.proxyLogs.id,
    routeId: schema.proxyLogs.routeId,
    channelId: schema.proxyLogs.channelId,
    accountId: schema.proxyLogs.accountId,
    downstreamApiKeyId: schema.proxyLogs.downstreamApiKeyId,
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

function buildProxyLogRouteContextSelectFields() {
  return {
    entryRouteId: schema.proxyLogs.entryRouteId,
    sourceRouteId: schema.proxyLogs.sourceRouteId,
  };
}

function buildProxyLogCacheSelectFields() {
  return {
    cacheStatus: schema.proxyLogs.cacheStatus,
    cacheSavedCost: schema.proxyLogs.cacheSavedCost,
  };
}

function buildProxyLogClientSelectFields() {
  return {
    clientFamily: schema.proxyLogs.clientFamily,
    clientAppId: schema.proxyLogs.clientAppId,
    clientAppName: schema.proxyLogs.clientAppName,
    clientConfidence: schema.proxyLogs.clientConfidence,
  };
}

function buildProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeClientFields?: boolean;
  includeCacheFields?: boolean;
  includeRouteContextFields?: boolean;
}) {
  return {
    ...buildProxyLogCoreSelectFields(),
    ...(options?.includeRouteContextFields ? buildProxyLogRouteContextSelectFields() : {}),
    ...(options?.includeCacheFields ? buildProxyLogCacheSelectFields() : {}),
    ...(options?.includeClientFields ? buildProxyLogClientSelectFields() : {}),
    ...(options?.includeBillingDetails ? { billingDetails: schema.proxyLogs.billingDetails } : {}),
  };
}

export async function getProxyLogBaseSelectFields() {
  return buildProxyLogSelectFields({
    includeCacheFields: await hasProxyLogCacheColumns(),
    includeRouteContextFields: await hasProxyLogRouteContextColumns(),
  });
}

export type ProxyLogSelectFields = ReturnType<typeof buildProxyLogSelectFields>;

export type ResolvedProxyLogSelectFields = {
  includeBillingDetails: boolean;
  includeClientFields: boolean;
  includeCacheFields: boolean;
  includeRouteContextFields: boolean;
  fields: ProxyLogSelectFields;
};

export async function resolveProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeClientFields?: boolean;
}) {
  const includeBillingDetails = options?.includeBillingDetails === true
    && await hasProxyLogBillingDetailsColumn();
  const includeClientFields = options?.includeClientFields !== false
    && await hasProxyLogClientColumns();
  const includeCacheFields = await hasProxyLogCacheColumns();
  const includeRouteContextFields = await hasProxyLogRouteContextColumns();

  return {
    includeBillingDetails,
    includeClientFields,
    includeCacheFields,
    includeRouteContextFields,
    fields: buildProxyLogSelectFields({
      includeBillingDetails,
      includeClientFields,
      includeCacheFields,
      includeRouteContextFields,
    }),
  };
}

export async function withProxyLogSelectFields<T>(
  runner: (selection: ResolvedProxyLogSelectFields) => Promise<T>,
  options?: { includeBillingDetails?: boolean; includeClientFields?: boolean },
): Promise<T> {
  let selection = await resolveProxyLogSelectFields(options);

  while (true) {
    try {
      return await runner(selection);
    } catch (error) {
      if (selection.includeBillingDetails && isMissingBillingDetailsColumnError(error)) {
        selection = {
          includeBillingDetails: false,
          includeClientFields: selection.includeClientFields,
          includeCacheFields: selection.includeCacheFields,
          includeRouteContextFields: selection.includeRouteContextFields,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: false,
            includeClientFields: selection.includeClientFields,
            includeCacheFields: selection.includeCacheFields,
            includeRouteContextFields: selection.includeRouteContextFields,
          }),
        };
        continue;
      }

      if (selection.includeClientFields && isMissingProxyLogClientColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeClientFields: false,
          includeCacheFields: selection.includeCacheFields,
          includeRouteContextFields: selection.includeRouteContextFields,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeClientFields: false,
            includeCacheFields: selection.includeCacheFields,
            includeRouteContextFields: selection.includeRouteContextFields,
          }),
        };
        continue;
      }

      if (selection.includeCacheFields && isMissingProxyLogCacheColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeClientFields: selection.includeClientFields,
          includeCacheFields: false,
          includeRouteContextFields: selection.includeRouteContextFields,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeClientFields: selection.includeClientFields,
            includeCacheFields: false,
            includeRouteContextFields: selection.includeRouteContextFields,
          }),
        };
        continue;
      }

      if (selection.includeRouteContextFields && isMissingProxyLogRouteContextColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeClientFields: selection.includeClientFields,
          includeCacheFields: selection.includeCacheFields,
          includeRouteContextFields: false,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeClientFields: selection.includeClientFields,
            includeCacheFields: selection.includeCacheFields,
            includeRouteContextFields: false,
          }),
        };
        continue;
      }

      throw error;
    }
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

function normalizeProxyLogStoreErrorMessage(error: unknown): string {
  const parts: string[] = [];

  if (typeof error === 'object' && error) {
    if ('message' in error) {
      parts.push(String((error as { message?: unknown }).message || ''));
    }
    if ('cause' in error) {
      const cause = (error as { cause?: unknown }).cause;
      if (cause instanceof Error) {
        parts.push(cause.message);
      } else if (cause != null) {
        parts.push(String(cause));
      }
    }
  } else {
    parts.push(String(error || ''));
  }

  return parts.join(' ').toLowerCase();
}

export function isMissingBillingDetailsColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('billing_details')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingDownstreamApiKeyIdColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('downstream_api_key_id')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogClientColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasClientColumnReference = [
    'client_family',
    'client_app_id',
    'client_app_name',
    'client_confidence',
  ].some((columnName) => lowered.includes(columnName));

  return hasClientColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogCacheColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasCacheColumnReference = ['cache_status', 'cache_saved_cost'].some((columnName) => lowered.includes(columnName));

  return hasCacheColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogRouteContextColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasRouteContextColumnReference = ['entry_route_id', 'source_route_id'].some((columnName) => lowered.includes(columnName));

  return hasRouteContextColumnReference
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
  const includeDownstreamApiKeyId = input.downstreamApiKeyId != null
    && await hasProxyLogDownstreamApiKeyIdColumn();
  const requestedClientFields = [
    input.clientFamily,
    input.clientAppId,
    input.clientAppName,
    input.clientConfidence,
  ].some((value) => value != null && String(value).trim().length > 0);
  const includeClientFields = requestedClientFields
    && await hasProxyLogClientColumns();
  const includeCacheFields = await hasProxyLogCacheColumns();
  const includeRouteContextFields = await hasProxyLogRouteContextColumns();

  let allowBillingDetails = includeBillingDetails;
  let allowDownstreamApiKeyId = includeDownstreamApiKeyId;
  let allowClientFields = includeClientFields;
  let allowCacheFields = includeCacheFields;
  let allowRouteContextFields = includeRouteContextFields;

  while (true) {
    const routeContextId = input.routeId ?? null;
    const values = {
      ...baseValues,
      ...(allowRouteContextFields
        ? {
          entryRouteId: input.entryRouteId ?? routeContextId,
          sourceRouteId: input.sourceRouteId ?? routeContextId,
        }
        : {}),
      ...(allowBillingDetails ? { billingDetails: serializedBillingDetails } : {}),
      ...(allowDownstreamApiKeyId ? { downstreamApiKeyId: input.downstreamApiKeyId } : {}),
      ...(allowClientFields
        ? {
          clientFamily: input.clientFamily ?? null,
          clientAppId: input.clientAppId ?? null,
          clientAppName: input.clientAppName ?? null,
          clientConfidence: input.clientConfidence ?? null,
        }
        : {}),
      ...(allowCacheFields
        ? {
          cacheStatus: input.cacheStatus ?? null,
          cacheSavedCost: input.cacheSavedCost ?? 0,
        }
        : {}),
    };

    try {
      await db.insert(schema.proxyLogs).values(values).run();
      return;
    } catch (error) {
      if (allowBillingDetails && isMissingBillingDetailsColumnError(error)) {
        allowBillingDetails = false;
        continue;
      }

      if (allowDownstreamApiKeyId && isMissingDownstreamApiKeyIdColumnError(error)) {
        allowDownstreamApiKeyId = false;
        continue;
      }

      if (allowClientFields && isMissingProxyLogClientColumnsError(error)) {
        allowClientFields = false;
        continue;
      }

      if (allowCacheFields && isMissingProxyLogCacheColumnsError(error)) {
        allowCacheFields = false;
        continue;
      }

      if (allowRouteContextFields && isMissingProxyLogRouteContextColumnsError(error)) {
        allowRouteContextFields = false;
        continue;
      }

      throw error;
    }
  }
}

export function insertProxyLogBestEffort(input: ProxyLogInsertInput, label = 'proxy log'): void {
  void insertProxyLog(input).catch((error) => {
    console.warn(`[${label}] failed to write proxy log`, error);
  });
}
