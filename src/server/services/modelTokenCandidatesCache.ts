const MODEL_TOKEN_CANDIDATES_TTL_MS = 30_000;

export type ModelTokenCandidateItem = {
  accountId: number;
  tokenId: number | null;
  tokenName: string | null;
  isDefault: boolean;
  username: string | null;
  siteId: number;
  siteName: string;
};

export type ModelTokenCandidateMissingItem = {
  accountId: number;
  username: string | null;
  siteId: number;
  siteName: string;
};

export type ModelTokenCandidateMissingGroupItem = {
  accountId: number;
  username: string | null;
  siteId: number;
  siteName: string;
  missingGroups: string[];
  requiredGroups: string[];
  availableGroups: string[];
  groupCoverageUncertain?: boolean;
};

export type ModelTokenCandidatesPayload = {
  models: Record<string, ModelTokenCandidateItem[]>;
  modelsWithoutToken: Record<string, ModelTokenCandidateMissingItem[]>;
  modelsMissingTokenGroups: Record<string, ModelTokenCandidateMissingGroupItem[]>;
  endpointTypesByModel: Record<string, string[]>;
};

type ModelTokenCandidatesCacheEntry = {
  expiresAt: number;
  payload: ModelTokenCandidatesPayload;
};

let modelTokenCandidatesCache: ModelTokenCandidatesCacheEntry | null = null;

export function readModelTokenCandidatesCache(): ModelTokenCandidatesPayload | null {
  if (!modelTokenCandidatesCache) return null;
  if (Date.now() >= modelTokenCandidatesCache.expiresAt) {
    modelTokenCandidatesCache = null;
    return null;
  }
  return modelTokenCandidatesCache.payload;
}

export function writeModelTokenCandidatesCache(payload: ModelTokenCandidatesPayload): void {
  modelTokenCandidatesCache = {
    expiresAt: Date.now() + MODEL_TOKEN_CANDIDATES_TTL_MS,
    payload,
  };
}

export function invalidateModelTokenCandidatesCache(): void {
  modelTokenCandidatesCache = null;
}
