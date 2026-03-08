import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

type RouteChannelCandidate = {
  channel: typeof schema.routeChannels.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  token: typeof schema.accountTokens.$inferSelect | null;
};

type MediaTaskKind = 'image' | 'video';

const IMAGE_POSITIVE_PATTERNS = [
  /imagen/i,
  /image-preview/i,
  /gpt-4o-image/i,
  /gpt-image/i,
  /flux/i,
  /midjourney/i,
  /qwen[-/.]?image/i,
  /z-image/i,
  /imagine/i,
];

const IMAGE_NEGATIVE_PATTERNS = [
  /video/i,
  /veo/i,
  /sora/i,
];

const VIDEO_POSITIVE_PATTERNS = [
  /video/i,
  /veo/i,
  /sora/i,
  /kling/i,
  /wan/i,
  /runway/i,
];

const VIDEO_NEGATIVE_PATTERNS = [
  /image/i,
  /imagen/i,
  /flux/i,
  /midjourney/i,
];

function normalizeModelName(modelName: string | null | undefined): string {
  const normalized = (modelName || '').trim().toLowerCase();
  if (!normalized) return '';
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1);
  }
  return normalized;
}

function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function inferModelSupportKind(modelName: string | null | undefined): MediaTaskKind | null {
  const normalized = normalizeModelName(modelName);
  if (!normalized) return null;
  if (matchesAnyPattern(normalized, VIDEO_POSITIVE_PATTERNS) && !matchesAnyPattern(normalized, VIDEO_NEGATIVE_PATTERNS)) {
    return 'video';
  }
  if (matchesAnyPattern(normalized, IMAGE_POSITIVE_PATTERNS) && !matchesAnyPattern(normalized, IMAGE_NEGATIVE_PATTERNS)) {
    return 'image';
  }
  return null;
}

function isModelAliasEquivalent(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeModelName(left);
  const b = normalizeModelName(right);
  return !!a && !!b && a === b;
}

function isCandidateExplicitlyCompatible(
  sourceModel: string | null | undefined,
  requestedModel: string,
  taskKind: MediaTaskKind,
): boolean {
  const sourceKind = inferModelSupportKind(sourceModel);
  const requestedKind = inferModelSupportKind(requestedModel);

  if (sourceKind && sourceKind !== taskKind) return false;
  if (requestedKind && requestedKind !== taskKind) return false;
  if (sourceKind === taskKind) return true;
  return requestedKind === taskKind;
}

function candidateMatchesAvailableModels(
  candidate: RouteChannelCandidate,
  availableModels: Set<string>,
  requestedModel: string,
  taskKind: MediaTaskKind,
): boolean {
  const sourceModel = candidate.channel.sourceModel || '';
  const normalizedRequestedModel = normalizeModelName(requestedModel);
  const normalizedSourceModel = normalizeModelName(sourceModel);

  if (normalizedSourceModel && availableModels.has(normalizedSourceModel)) return true;
  if (normalizedRequestedModel && availableModels.has(normalizedRequestedModel)) return true;

  for (const modelName of availableModels) {
    if (normalizedSourceModel && isModelAliasEquivalent(modelName, normalizedSourceModel)) return true;
    if (normalizedRequestedModel && isModelAliasEquivalent(modelName, normalizedRequestedModel)) return true;
  }

  const sourceKind = inferModelSupportKind(sourceModel);
  if (sourceKind && sourceKind !== taskKind) return false;

  const requestedKind = inferModelSupportKind(requestedModel);
  if (requestedKind && requestedKind !== taskKind) return false;

  for (const modelName of availableModels) {
    if (inferModelSupportKind(modelName) === taskKind) return true;
  }

  return false;
}

export async function filterCandidatesByTokenModelAvailability(
  candidates: RouteChannelCandidate[],
  requestedModel: string,
  taskKind: MediaTaskKind,
): Promise<RouteChannelCandidate[]> {
  if (candidates.length <= 1) return candidates;

  const tokenIds = Array.from(new Set(candidates
    .map((candidate) => candidate.token?.id)
    .filter((tokenId): tokenId is number => typeof tokenId === 'number' && Number.isFinite(tokenId))));

  const explicitMatches = candidates.filter((candidate) => isCandidateExplicitlyCompatible(candidate.channel.sourceModel, requestedModel, taskKind));

  if (tokenIds.length === 0) {
    return explicitMatches.length > 0 ? explicitMatches : candidates;
  }

  const rows = await db.select()
    .from(schema.tokenModelAvailability)
    .where(
      and(
        inArray(schema.tokenModelAvailability.tokenId, tokenIds),
        eq(schema.tokenModelAvailability.available, true),
      ),
    )
    .all();

  const availableModelsByTokenId = new Map<number, Set<string>>();
  for (const row of rows) {
    const normalizedModelName = normalizeModelName(row.modelName);
    if (!normalizedModelName) continue;
    if (!availableModelsByTokenId.has(row.tokenId)) {
      availableModelsByTokenId.set(row.tokenId, new Set<string>());
    }
    availableModelsByTokenId.get(row.tokenId)!.add(normalizedModelName);
  }

  const matchedByAvailability = candidates.filter((candidate) => {
    const tokenId = candidate.token?.id;
    if (typeof tokenId !== 'number') return false;
    const availableModels = availableModelsByTokenId.get(tokenId);
    if (!availableModels || availableModels.size === 0) return false;
    return candidateMatchesAvailableModels(candidate, availableModels, requestedModel, taskKind);
  });

  if (matchedByAvailability.length > 0) return matchedByAvailability;
  if (explicitMatches.length > 0) return explicitMatches;
  return candidates;
}

export async function markTokenModelUnavailable(tokenId: number | null | undefined, modelName: string | null | undefined): Promise<void> {
  if (typeof tokenId !== 'number' || !Number.isFinite(tokenId)) return;
  const normalizedModelName = (modelName || '').trim();
  if (!normalizedModelName) return;

  await db.update(schema.tokenModelAvailability)
    .set({
      available: false,
      checkedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.tokenModelAvailability.tokenId, tokenId),
        eq(schema.tokenModelAvailability.modelName, normalizedModelName),
      ),
    )
    .run();
}
